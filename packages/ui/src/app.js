const byId = id => document.getElementById(id)
const form = byId('request')
let token
let requestId
let attempt
const message = value => { byId('message').textContent = value }
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), ...options.headers }
  })
  const body = await response.json()
  if (response.status === 401 && token) {
    token = undefined
    byId('intake').hidden = true
    byId('sign-in').hidden = false
  }
  if (!response.ok) throw new Error(body.error ?? (typeof body === 'string' ? body : 'Request failed.'))
  return body
}

async function signIn() {
  const config = await api('/api/sign-in')
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const state = crypto.randomUUID()
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  sessionStorage.setItem('intake-login', JSON.stringify({ verifier, state }))
  const url = new URL('/oauth2/authorize', config.hostedUrl)
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code',
    scope: 'openid', state, code_challenge: challenge, code_challenge_method: 'S256'
  })
  location.assign(url)
}

function append(parent, tag, content) {
  const element = document.createElement(tag)
  element.textContent = content
  parent.append(element)
  return element
}

async function show(id) {
  const revisions = await api(`/api/requests/${id}`)
  const details = byId('details')
  details.replaceChildren()
  append(details, 'h2', `Request ${id}`)
  revisions.sort((a, b) => b.events[0].at.localeCompare(a.events[0].at))
  for (const revision of revisions) {
    append(details, 'h3', `Revision ${revision.revisionId}`)
    const history = append(details, 'ul', '')
    for (const event of revision.events) append(history, 'li', `${event.at} · ${event.status}`)
    for (const correction of revision.corrections) append(details, 'p', correction)
  }
  append(details, 'button', 'Correct this request').onclick = () => {
    form.reset()
    requestId = id
    for (const [field, value] of Object.entries(revisions[0].normalizedRequirements)) {
      form.elements[field].value = value
    }
    form.elements.baselineVersion.value = revisions[0].baselineVersion
    const submission = revisions[0].sources.find(source => source.key.endsWith('/submission.json'))
    form.elements.guidelineUrls.value = revisions[0].references
      .filter(reference => reference.source === submission?.key).map(reference => reference.url).join('\n')
    byId('form-title').textContent = 'Correct request'
    message('Select any guideline attachment you want included in this revision.')
    form.elements.goal.focus()
  }
}

async function refresh() {
  const revisions = await api('/api/requests')
  const list = byId('requests')
  list.replaceChildren()
  const latest = new Map()
  for (const revision of revisions.sort((a, b) => b.events[0].at.localeCompare(a.events[0].at))) {
    if (!latest.has(revision.requestId)) latest.set(revision.requestId, revision)
  }
  for (const revision of latest.values()) {
    const item = append(list, 'li', '')
    append(item, 'button', revision.normalizedRequirements.goal || revision.requestId)
      .onclick = () => show(revision.requestId).catch(error => message(error.message))
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault()
  const button = event.submitter
  const path = requestId ? `/api/requests/${requestId}` : '/api/requests'
  button.disabled = true
  try {
    const data = new FormData(form)
    const file = data.get('attachment')
    const payload = Object.fromEntries(data)
    delete payload.attachment
    payload.guidelineUrls = payload.guidelineUrls.split(/\r?\n/).map(url => url.trim()).filter(Boolean)
    if (file?.name) {
      if (file.size > 256 * 1024) throw new Error('Choose an attachment of at most 256 KiB.')
      let binary = ''
      for (const byte of new Uint8Array(await file.arrayBuffer())) binary += String.fromCharCode(byte)
      payload.attachment = { name: file.name, base64: btoa(binary) }
    }
    const body = JSON.stringify(payload)
    if (attempt?.body !== body || attempt.path !== path) attempt = { path, body, key: crypto.randomUUID() }
    const revision = await api(path, {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.key }
    })
    await show(revision.requestId)
    await refresh()
    message(`Revision saved with status ${revision.screeningStatus}.`)
    attempt = undefined
    byId('new-request').click()
  } catch (error) {
    message(error.message)
  } finally {
    button.disabled = false
  }
})

byId('new-request').onclick = () => {
  form.reset()
  requestId = undefined
  byId('form-title').textContent = 'New request'
}
byId('sign-out').onclick = () => location.replace('/')
byId('sign-in').onclick = () => signIn().catch(error => message(error.message))

try {
  const query = new URLSearchParams(location.search)
  if (query.has('code') || query.has('error')) {
    history.replaceState(null, '', '/')
    const login = JSON.parse(sessionStorage.getItem('intake-login'))
    sessionStorage.removeItem('intake-login')
    if (!login || login.state !== query.get('state') || !query.has('code')) throw new Error('Sign-in could not be completed.')
    const session = await api('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: query.get('code'), verifier: login.verifier })
    })
    token = session.token
    const versions = await api('/api/versions')
    for (const version of versions) form.elements.baselineVersion.add(new Option(version, version))
    await refresh()
    byId('sign-in').hidden = true
    byId('intake').hidden = false
  }
} catch (error) {
  message(error.message)
}
