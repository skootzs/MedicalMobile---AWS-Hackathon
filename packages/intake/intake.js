import { createHash, randomUUID } from 'node:crypto'

export const maxAttachmentBytes = 256 * 1024
export const maxBodyBytes = 400 * 1024
export const fields = ['goal', 'pathway', 'targetUsers', 'acceptanceCriteria']
export const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export const serializeRequirements = requirements =>
  JSON.stringify(Object.fromEntries(fields.map(field => [field, requirements[field]])))

/**
 * @typedef {{bucket: string, key: string, versionId: string, sha256: string, filename?: string}} SourceVersion
 * @typedef {object} RequestSnapshot
 * @property {string} requestId
 * @property {string} revisionId
 * @property {string} authorId
 * @property {SourceVersion[]} sources
 * @property {{url: string, source: string, versionId: string}[]} references
 * @property {Record<string, string>} normalizedRequirements
 * @property {string} requirementsHash
 * @property {string} baselineVersion
 * @property {string|null} baselineHash
 * @property {'blocked'|'pending_screening'|'passed'} screeningStatus
 * @property {string[]} corrections
 * @property {{status: string, at: string}[]} events
 */
const roles = ['PO', 'service designer', 'developer', 'clinician', 'release approver']
const allowed = new Set([...fields, 'baselineVersion', 'guidelineUrls', 'attachment'])

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export async function authenticate(header, verify, getRoles) {
  return (await authenticateProfile(header, verify, getRoles)).authorId
}

export async function authenticateProfile(header, verify, getRoles) {
  const match = /^Bearer (\S+)$/i.exec(header ?? '')
  if (!match) throw new HttpError(401, 'Sign in to continue.')
  let claims
  try {
    claims = await verify(match[1])
  } catch {
    throw new HttpError(401, 'Your access token is invalid or expired.')
  }
  if (typeof claims.sub !== 'string' || !claims.sub) throw new HttpError(401, 'Invalid identity.')
  const assigned = (await getRoles(claims.sub)).filter(role => roles.includes(role))
  if (!assigned.includes('PO')) throw new HttpError(403, 'This account requires the PO role.')
  return { authorId: claims.sub, username: claims.username || claims.sub, roles: assigned }
}

function parseAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment) ||
      Object.keys(attachment).some(key => !['name', 'base64'].includes(key)) ||
      typeof attachment.name !== 'string' || attachment.name.length > 255 ||
      typeof attachment.base64 !== 'string') {
    throw new Error('Select a valid attachment.')
  }
  if (attachment.base64.length > Math.ceil(maxAttachmentBytes / 3) * 4) {
    throw new Error('The attachment exceeds 256 KiB.')
  }
  if (!/\.(txt|md)$/i.test(attachment.name)) throw new Error('Use a TXT or Markdown attachment.')
  const bytes = Buffer.from(attachment.base64, 'base64')
  if (bytes.length > maxAttachmentBytes) throw new Error('The attachment exceeds 256 KiB.')
  if (bytes.toString('base64') !== attachment.base64) throw new Error('The attachment encoding is malformed.')
  let content
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) throw new Error()
  } catch {
    throw new Error('Save the attachment as UTF-8 text and try again.')
  }
  if (!content.trim()) throw new Error('The attachment is empty.')
  const urls = [...new Set(content.match(/https?:\/\/[^\s<>")\]]+/gi) ?? [])]
  if (urls.length > 20 || urls.some(url => url.length > 2048)) {
    throw new Error('Use at most 20 guideline links of up to 2,048 characters in the attachment.')
  }
  return { bytes, urls }
}

function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password &&
      url.hostname.includes('.') && !url.hostname.endsWith('.local') &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)
  } catch {
    return false
  }
}

export async function submit({ store, registry, author, requestId, key, raw, oversized = false, commitGuard }) {
  if (!/^[\w-]{16,128}$/.test(key ?? '')) throw new HttpError(400, 'Provide a valid idempotency key.')
  let input = {}
  if (!oversized) {
    try {
      input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
    } catch {
      throw new HttpError(400, 'The submission must be valid JSON.')
    }
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(field => !allowed.has(field)) ||
        (input.attachment && typeof input.attachment === 'object' &&
          Object.keys(input.attachment).some(field => !['name', 'base64'].includes(field)))) {
      throw new HttpError(400, 'The submission includes an unsupported field.')
    }
  }

  const fingerprint = hash(JSON.stringify([requestId ?? null, oversized ? raw : hash(raw)]))
  if (requestId && !(await store.history(author, requestId)).length) {
    throw new HttpError(404, 'Request not found.')
  }
  const version = typeof input.baselineVersion === 'string' ? input.baselineVersion.trim() : ''
  const reservation = await store.reserve(author, key, {
    fingerprint, requestId: requestId ?? randomUUID(), revisionId: randomUUID(),
    receivedAt: new Date().toISOString(),
    baselineHash: Object.hasOwn(registry, version) ? registry[version] : null
  })
  if (reservation.fingerprint !== fingerprint) throw new HttpError(409, 'This key was used for a different submission.')
  if (reservation.result) return reservation.result

  const normalized = Object.fromEntries(fields.map(field => [
    field, typeof input[field] === 'string' ? input[field].normalize('NFC').trim().replace(/\r\n?/g, '\n') : ''
  ]))
  const { baselineHash } = reservation
  const urls = input.guidelineUrls ?? []
  const validUrls = Array.isArray(urls) && urls.length <= 20 && urls.every(publicUrl)
  const corrections = []
  let attachment
  if (oversized) {
    corrections.push('The submission is too large. Use an attachment of at most 256 KiB.')
  } else {
    for (const field of fields) {
      if (!normalized[field] || normalized[field].length > 4000) {
        corrections.push(`Provide ${field} in 1 to 4,000 characters.`)
        normalized[field] = ''
      }
    }
    if (!baselineHash) corrections.push('Choose a configuration version listed in the registry.')
    if (!validUrls) corrections.push('Provide up to 20 public HTTP or HTTPS guideline URLs.')
    if (input.attachment !== undefined) {
      try {
        attachment = parseAttachment(input.attachment)
      } catch (error) {
        corrections.push(error.message)
      }
    }
  }

  const prefix = `intake/${reservation.revisionId}`
  const sources = []
  const references = []
  if (!oversized) {
    const submission = await store.source(`${prefix}/submission.json`, raw)
    sources.push(submission)
    if (validUrls) for (const url of urls) references.push({ url, source: submission.key, versionId: submission.versionId })
  }
  if (attachment) {
    const source = await store.source(`${prefix}/attachment`, attachment.bytes)
    sources.push({ ...source, filename: input.attachment.name })
    for (const url of attachment.urls.filter(publicUrl)) {
      references.push({ url, source: source.key, versionId: source.versionId })
    }
  }
  const status = corrections.length ? 'blocked' : 'pending_screening'
  return store.finish(author, key, {
    requestId: reservation.requestId, revisionId: reservation.revisionId, authorId: author,
    normalizedRequirements: normalized, requirementsHash: hash(serializeRequirements(normalized)),
    baselineVersion: version.length <= 256 ? version : '', baselineHash, sources, references,
    screeningStatus: status, corrections,
    events: [{ status: 'received', at: reservation.receivedAt }, { status, at: new Date().toISOString() }]
  }, commitGuard)
}

/**
 * Legacy phase-one boundary remains closed. Phase two queues a durable handoff
 * through createReview.confirm after checking stored screening and confirmation.
 * A future dispatcher must validate those durable records, never caller assertions.
 */
export async function handoff() {
  return false
}
