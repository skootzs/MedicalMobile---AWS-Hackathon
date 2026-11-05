import { createUiResponder } from '../ui/serve.js'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { CognitoJwtVerifier } from 'aws-jwt-verify'
import { authenticate, authenticateProfile, HttpError, maxBodyBytes, submit } from './intake.js'
import { createStore } from './storage.js'
import { screeningConfig, createScreener } from './screening.js'
import { createReview } from './review.js'
import { createFlowchartGenerator } from './flowchart.js'
import { credentialsUnavailableMessage } from './credentials.js'

const { COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, COGNITO_HOSTED_URL,
  COGNITO_REDIRECT_URI, INTAKE_TABLE, INTAKE_BUCKET, INTAKE_REGISTRY, HOST = '127.0.0.1', PORT = '3000' } = process.env
const hosted = new URL(COGNITO_HOSTED_URL)
if (hosted.protocol !== 'https:') throw new Error('Cognito requires HTTPS.')
const callback = new URL(COGNITO_REDIRECT_URI)
const registry = JSON.parse(await readFile(INTAKE_REGISTRY, 'utf8'))
if (!registry || typeof registry !== 'object' || Array.isArray(registry) ||
    !Object.entries(registry).every(([version, digest]) =>
      version && version.trim() === version && version.length <= 256 && /^[a-f0-9]{64}$/.test(digest))) {
  throw new Error('The configuration registry must map versions to SHA-256 hashes.')
}
if (!INTAKE_TABLE || !INTAKE_BUCKET) throw new Error('Configure the intake table and bucket.')
const verifier = CognitoJwtVerifier.create({
  userPoolId: COGNITO_USER_POOL_ID, clientId: COGNITO_CLIENT_ID, tokenUse: 'access'
})
const store = createStore({ table: INTAKE_TABLE, bucket: INTAKE_BUCKET })
const screening = screeningConfig()
const review = createReview({ store, registry, config: screening, screen: screening.enabled ? createScreener(screening) : null,
  generateFlowchart: screening.enabled ? createFlowchartGenerator(screening) : null })
const serveUi = createUiResponder()

async function readSubmission(req) {
  const digest = createHash('sha256')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 8 * maxBodyBytes) throw new HttpError(413, 'The upload exceeded the transport limit.')
    digest.update(chunk)
    if (size <= maxBodyBytes) chunks.push(chunk)
  }
  return size > maxBodyBytes
    ? { raw: digest.digest('hex'), oversized: true }
    : { raw: Buffer.concat(chunks) }
}

const server = createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  try {
    const path = new URL(req.url, 'http://localhost').pathname
    if (await serveUi(req, res, path)) return
    if (path === '/api/sign-in' && req.method === 'GET') {
      return send(200, { hostedUrl: hosted.origin, clientId: COGNITO_CLIENT_ID, redirectUri: callback.href })
    }
    if (path === '/logout' && req.method === 'GET') {
      const logout = new URL('/logout', hosted)
      logout.search = new URLSearchParams({ client_id: COGNITO_CLIENT_ID, logout_uri: new URL('/signed-out', callback).href })
      res.writeHead(302, { Location: logout.href, 'Cache-Control': 'no-store' })
      return res.end()
    }
    if (path === '/api/session' && req.method === 'POST') {
      const { raw, oversized } = await readSubmission(req)
      if (oversized) throw new HttpError(400, 'Invalid sign-in response.')
      let login
      try {
        login = JSON.parse(raw.toString('utf8'))
      } catch {
        throw new HttpError(400, 'Invalid sign-in response.')
      }
      const { code, verifier: codeVerifier } = login ?? {}
      if (typeof code !== 'string' || typeof codeVerifier !== 'string') throw new HttpError(400, 'Invalid sign-in response.')
      const response = await fetch(new URL('/oauth2/token', hosted), {
        method: 'POST', body: new URLSearchParams({
          grant_type: 'authorization_code', client_id: COGNITO_CLIENT_ID,
          code, code_verifier: codeVerifier, redirect_uri: callback.href
        }), signal: AbortSignal.timeout(10000)
      })
      if (!response.ok) throw new HttpError(401, 'Sign-in could not be completed.')
      const { access_token: token } = await response.json()
      await authenticate(`Bearer ${token}`, value => verifier.verify(value), store.roles)
      return send(200, { token })
    }
    const profile = await authenticateProfile(req.headers.authorization, value => verifier.verify(value), store.roles)
    const author = profile.authorId
    if (path === '/api/profile' && req.method === 'GET') return send(200, profile)
    const reviewRoute = /^\/api\/requests\/([a-f0-9-]{36})\/revisions\/([a-f0-9-]{36})\/(screening|preview|confirmation|rejection|revise)$/.exec(path)
    if (reviewRoute) {
      const [, requestId, revisionId, action] = reviewRoute
      if (req.method === 'GET' && action === 'screening') return send(200, await review.get(author, requestId, revisionId))
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.')
      const { raw, oversized } = await readSubmission(req)
      let input
      try { input = oversized ? null : JSON.parse(raw.toString('utf8') || '{}') } catch { throw new HttpError(400, 'Provide valid JSON.') }
      if (!input || Array.isArray(input) || typeof input !== 'object') throw new HttpError(400, 'Provide a JSON object.')
      if (['screening', 'preview'].includes(action) && Object.keys(input).length) throw new HttpError(400, 'This action accepts no fields.')
      return send(200, action === 'screening' ? await review.screen(author, requestId, revisionId)
        : action === 'preview' ? await review.preview(author, requestId, revisionId)
          : action === 'rejection' ? await review.reject(author, requestId, revisionId, input)
            : action === 'revise' ? await review.revise(author, requestId, revisionId, input, req.headers['idempotency-key'])
              : await review.confirm(author, requestId, revisionId, input))
    }
    const match = /^\/api\/requests(?:\/([a-f0-9-]{36})(?:\/revisions\/([a-f0-9-]{36}))?)?$/.exec(path)
    if (path === '/api/versions' && req.method === 'GET') return send(200, Object.keys(registry))
    if (!match) throw new HttpError(404, 'Page not found.')
    const [, requestId, revisionId] = match
    if (req.method === 'GET') {
      const result = revisionId ? await store.revision(author, requestId, revisionId)
        : requestId ? await store.history(author, requestId) : await store.list(author)
      if (!result || (requestId && Array.isArray(result) && !result.length)) throw new HttpError(404, 'Request not found.')
      return send(200, result)
    }
    if (req.method === 'POST' && !revisionId) {
      return send(200, await submit({
        store, registry, author, requestId, key: req.headers['idempotency-key'], ...await readSubmission(req)
      }))
    }
    throw new HttpError(405, 'Method not allowed.')
  } catch (error) {
    if (!error.status) console.error('Intake operation failed', error.name)
    const message = error.name === 'CredentialsProviderError' || error.name === 'TokenProviderError'
      ? credentialsUnavailableMessage
      : error.status ? error.message : 'Temporarily unavailable. Retry the same submission.'
    if (!res.destroyed) send(error.status ?? 503, message)
  }
})
server.listen(Number(PORT), HOST)
