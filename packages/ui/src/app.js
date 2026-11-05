import { trackingState } from '/tracking.js'
const byId = id => document.getElementById(id)
const form = byId('request')
let token
let requestId
let attempt
let viewSequence = 0
let signOutRedirect
const message = value => { byId('message').textContent = value; window.chtWorkspace?.message(value) }
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
    byId('welcome').hidden = false
    byId('account-actions').hidden = true
    byId('profile-dialog').close()
    viewSequence++
    requestId = undefined
    attempt = undefined
    form.reset()
    byId('requests').replaceChildren()
    byId('details').replaceChildren()
    byId('signed-in-name').textContent = ''
    window.chtWorkspace?.signedOut()
  }
  if (!response.ok) {
    const error = new Error(body?.error ?? (typeof body === 'string' ? body : 'Request failed.'))
    error.status = response.status
    throw error
  }
  return body
}

async function signIn() {
  clearTimeout(signOutRedirect)
  sessionStorage.setItem('intake-return-to', safeReturnPath(location.pathname + location.search))
  const config = await api('/api/sign-in')
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const state = crypto.randomUUID()
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  sessionStorage.setItem('intake-login', JSON.stringify({ verifier, state }))
  const url = new URL('/oauth2/authorize', config.hostedUrl)
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code',
    scope: 'openid', prompt: 'login', state, code_challenge: challenge, code_challenge_method: 'S256'
  })
  location.assign(url)
}

function append(parent, tag, content) {
  const element = document.createElement(tag)
  element.textContent = content
  parent.append(element)
  return element
}

function safeReturnPath(path) {
  return typeof path === 'string' && (/^\/(?:saved|recent|protocols(?:\/[a-f0-9-]{36}(?:\/draft)?)?|collections(?:\/[a-z0-9-]+)?|guidelines\/[a-z0-9-]+|requests(?:\/(?:new|[a-f0-9-]{36}))?)$/.test(path) || /^\/(?:\?q=[^#]*)?$/.test(path)) ? path : '/'
}
function navigate(path, replace = false) {
  message('')
  window.chtWorkspace?.requestNavigation(path)
  const isNew = path === '/requests/new'
  const isDetail = /^\/requests\/[a-f0-9-]{36}$/.test(path)
  viewSequence++
  byId('requests-overview').hidden = isDetail
  byId('details').hidden = !isDetail
  history[replace ? 'replaceState' : 'pushState'](null, '', path)
  byId('new-request-page').hidden = !isNew
  byId('requests-page').hidden = isNew
  byId('nav-new').setAttribute('aria-current', isNew ? 'page' : 'false')
  byId('nav-requests').setAttribute('aria-current', isNew ? 'false' : 'page')
  byId('page-title').textContent = isNew ? 'New request' : isDetail ? 'Request tracking' : 'Your requests'
  byId('page-intro').textContent = isNew
    ? 'Describe the change. Supporting guideline links and uploads are optional.'
    : isDetail ? 'Follow your request through each stop in the process.' : 'Track your submissions, review revisions, and make corrections.'
  document.title = `${isNew ? 'New request' : isDetail ? 'Request tracking' : 'Your requests'} · Community Health Toolkit`
}

byId('nav-requests').onclick = async event => {
  event.preventDefault()
  navigate('/requests')
  try { await refresh() } catch (error) { message(error.message) }
}
byId('nav-new').onclick = event => {
  event.preventDefault()
  byId('new-request').click()
  navigate('/requests/new')
}
window.addEventListener('popstate', () => {
  if (!token) return
  if (/^\/requests\/[a-f0-9-]{36}$/.test(location.pathname)) {
    show(location.pathname.split('/').pop(), true).catch(error => message(error.message))
  } else if (location.pathname.startsWith('/requests')) navigate(location.pathname === '/requests/new' ? '/requests/new' : '/requests', true)
})

function renderTracking(parent, revision, state, onNext) {
  if (window.chtWorkspace?.renderTracking(parent, revision, state, onNext)) return
  const model = trackingState(revision, state)
  parent.replaceChildren()
  const summary = append(parent, 'div', '')
  summary.className = `tracking-summary${model.attention ? ' needs-attention' : ''}`
  append(summary, 'p', 'CURRENT STOP').className = 'eyebrow'
  append(summary, 'h3', model.headline)
  append(summary, 'p', model.steps[model.current].description)
  const route = append(parent, 'ol', '')
  route.className = 'tracking-route'
  route.setAttribute('aria-label', 'Request progress')
  for (const [index, step] of model.steps.entries()) {
    const stop = append(route, 'li', '')
    stop.className = `tracking-stop ${step.state}`
    if (index === model.current) stop.setAttribute('aria-current', 'step')
    const marker = append(stop, 'span', step.state === 'complete' ? '✓' : String(index + 1).padStart(2, '0'))
    marker.className = 'stop-marker'
    marker.setAttribute('aria-hidden', 'true')
    const content = append(stop, 'div', '')
    append(content, 'span', ({ complete: 'Completed', current: 'Current stop', attention: 'Needs attention', upcoming: 'Upcoming' })[step.state]).className = 'stop-state'
    append(content, 'h4', step.label)
    append(content, 'p', step.description)
  }
}

async function show(id, replace = false) {
  navigate(`/requests/${id}`, replace)
  window.chtWorkspace?.requestOpened(id)
  const sequence = viewSequence
  const details = byId('details')
  details.replaceChildren()
  append(details, 'p', 'Loading request…')
  let revisions
  try {revisions = await api(`/api/requests/${id}`)} catch(error) {
    if(sequence===viewSequence) {details.replaceChildren();append(details,'h2',error.status===404?'Request unavailable':'Could not load request');append(details,'p',error.message)}
    throw error
  }
  if (sequence !== viewSequence) return
  details.hidden = false
  details.replaceChildren()
  const back = append(details, 'button', '← All requests')
  back.className = 'tracking-back'
  back.onclick = async () => {navigate('/requests');try {await refresh()} catch(error){message(error.message)}}
  revisions.sort((a, b) => b.events[0].at.localeCompare(a.events[0].at))
  const latest = revisions[0]
  let latestReview
  const header=append(details, 'header', '')
  header.className='protocol-tracking-heading'
  const title=append(header, 'div', '')
  append(title, 'p', 'Configuration request').className='eyebrow'
  append(title, 'h1', latest.normalizedRequirements.goal || 'Configuration request')
  append(title, 'p', `Request ${id} · Current revision ${latest.revisionId}`).className = 'tracking-reference'
  const tracker = document.createElement('section')
  append(tracker, 'p', latest.screeningStatus === 'blocked' ? 'Local validation blocked this revision.' : 'Loading current review state…')
  const actions = append(header, 'div', '')
  actions.className = 'tracking-heading-actions'
  const summaryButton = append(actions, 'button', 'View request summary')
  summaryButton.type = 'button'
  const auditButton = append(actions, 'button', 'Audit history')
  auditButton.type = 'button'
  details.append(tracker)
  append(details, 'h3', 'Revision history').id = 'revision-history-title'
  append(details, 'p', 'Available revision events and current review information; not a complete clinical audit trail.').className='small'
  auditButton.onclick = () => { byId('revision-history-title').tabIndex = -1; byId('revision-history-title').focus(); byId('revision-history-title').scrollIntoView?.({ block: 'start' }) }
  summaryButton.onclick = () => { const entry = details.querySelector?.('.revision-entry'); if (entry) {entry.open = true;entry.scrollIntoView({block:'start'}); entry.querySelector('summary')?.focus()} }
  function next(action) {
    if (action === 'correct') return openCorrection()
    if (action === 'reload') return show(id,true).catch(error=>message(error.message))
    const entry=details.querySelector('.revision-entry')
    entry.open=true
    const control=entry.querySelector(`[data-review-action="${action}"]`)
    if (action==='review') {const preview=entry.querySelector('.request-preview')||control;preview?.scrollIntoView({block:'start'});preview?.focus({preventScroll:true})}
    else control?.click()
  }
  if (latest.screeningStatus === 'blocked') renderTracking(tracker, latest, {status:'blocked',enabled:false}, next)
  for (const revision of revisions) {
    const entry = append(details, 'details', '')
    entry.className = 'revision-entry'
    entry.open = revision === latest
    append(entry, 'summary', `Revision ${revision.revisionId} · ${new Date(revision.events[0].at).toLocaleString()}`)
    append(entry, 'h3', `Revision ${revision.revisionId}`)
    append(entry, 'h4', 'Saved request summary')
    for (const [field,value] of Object.entries(revision.normalizedRequirements)) {
      const item=append(entry, 'div', ''); item.className='requirement-value'
      append(item, 'strong', field); append(item, 'p', value)
    }
    append(entry, 'p', `Baseline: ${revision.baselineVersion}`)
    for (const source of revision.sources) append(entry, 'p', `Source: ${source.filename || 'Submitted requirements'} · SHA-256 ${source.sha256}`).className='small'
    for (const reference of revision.references) append(entry, 'p', `Reference: ${reference.url}`).className='small'
    const history = append(entry, 'ul', '')
    for (const event of revision.events) append(history, 'li', `${new Date(event.at).toLocaleString()} · ${event.status.replaceAll('_', ' ')}`)
    for (const correction of revision.corrections) append(entry, 'p', correction)
    if (revision.screeningStatus !== 'blocked') await showReview(entry, revision, revision === latest ? state => { latestReview = state; renderTracking(tracker, latest, state, next) } : undefined, openCorrection, () => sequence === viewSequence)
    if (sequence !== viewSequence) return
  }
  const edit = append(details, 'button', 'Edit')
  edit.type = 'button'
  edit.className = 'edit-request'
  edit.onclick = () => openCorrection()
  function openCorrection(feedback = '') {
    form.reset()
    requestId = id
    for (const [field, value] of Object.entries(revisions[0].normalizedRequirements)) {
      form.elements[field].value = value
    }
    form.elements.baselineVersion.value = revisions[0].baselineVersion
    const submission = revisions[0].sources.find(source => source.key.endsWith('/submission.json'))
    form.elements.guidelineUrls.value = revisions[0].references
      .filter(reference => reference.source === submission?.key).map(reference => reference.url).join('\n')
    const notice = byId('correction-notice')
    const items = byId('correction-items')
    items.replaceChildren()
    const changes = [...latest.corrections]
    if (feedback.trim()) changes.push(`Preview feedback: ${feedback.trim()}`)
    for (const issue of latestReview?.result?.issues ?? []) {
      const labels = { goal: 'Goal', pathway: 'Affected pathway', targetUsers: 'Target users', acceptanceCriteria: 'Acceptance criteria', baselineVersion: 'Configuration version', guideline: 'Guideline evidence' }
      changes.push(`${labels[issue.field] ?? issue.field}: ${issue.question}`)
    }
    if (latestReview?.message) changes.push(latestReview.message)
    for (const change of new Set(changes)) append(items, 'li', change)
    byId('correction-title').textContent = changes.length ? 'Changes needed' : 'Review your request'
    byId('correction-context').textContent = changes.length
      ? 'Address these items from the current revision before submitting your correction.'
      : 'No specific changes were requested. Update the details you want to revise below.'
    notice.hidden = false
    byId('form-title').textContent = 'Correct request'
    navigate('/requests/new')
    byId('page-title').textContent = 'Correct request'
    message('Select any guideline attachment you want included in this revision.')
    notice.focus()
  }
}

async function showReview(parent, revision, onState, onCorrect, isCurrent = () => true) {
  const base = `/api/requests/${revision.requestId}/revisions/${revision.revisionId}`
  const panel = append(parent, 'section', '')
  let state
  try { state = await api(`${base}/screening`) } catch (error) {
    if (isCurrent()) { onState?.({enabled:false,loadError:true,message:error.message}); append(panel, 'p', error.message); message(error.message); const retry=append(panel, 'button', 'Retry loading review'); retry.type='button'; retry.onclick=()=>show(revision.requestId,true).catch(error=>message(error.message)) }
    return
  }
  const render = (revealPreview = false) => {
    if (!isCurrent()) return
    panel.replaceChildren()
    onState?.(state)
    append(panel, 'p', `Screening: ${state.status}`)
    if (state.attemptId) append(panel, 'p', `Screening attempt: ${state.attemptId}`).className = 'small'
    if (state.message) append(panel, 'p', state.message)
    if (!state.enabled) { append(panel, 'p', 'Bedrock screening has not been enabled.'); return }
    const action = (label, path, body = {}) => {
      const button = append(panel, 'button', label)
      button.type = 'button'
      button.setAttribute('data-review-action', path)
      if(path==='screening')button.setAttribute('data-screening-revision',revision.revisionId)
      button.onclick = async () => {
        button.disabled = true
        message('')
        if(path==='screening') {
          button.textContent='Screening…'
          button.setAttribute('aria-busy','true')
          button.setAttribute('data-screening-busy','true')
          window.chtWorkspace?.screeningBusy?.(revision.revisionId,true)
        }
        try {
          state = await api(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          if (path === 'screening' && state.status === 'screening_passed' && !state.preview && !state.rejection) {
            button.textContent = 'Generating flowchart…'
            try {
              state = await api(`${base}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            } catch (error) {
              render()
              await reviewError(error)
              return
            }
          }
          render(path==='preview' || (path==='screening' && Boolean(state.preview)))
        } catch (error) { await reviewError(error); button.disabled = false }
        finally {
          if(path==='screening') {
            button.textContent=label
            button.setAttribute('aria-busy','false')
            button.setAttribute('data-screening-busy','false')
            window.chtWorkspace?.screeningBusy?.(revision.revisionId,false)
          }
        }
      }
    }
    async function reviewError(error) {
      if (!isCurrent()) return
      if (error.status === 409) {
        try { await show(revision.requestId, true) } catch (refreshError) { message(refreshError.message); return }
        message(`${error.message} Request and review state refreshed. Review the current revision, then choose an action.`)
      } else message(error.message)
    }
    if (state.result) {
      append(panel, 'p', state.result.summary)
      for (const issue of state.result.issues ?? []) append(panel, 'p', `${issue.field}: ${issue.question}`)
      for (const evidence of state.result.evidence ?? []) append(panel, 'p', `Evidence: ${evidence.source} · ${evidence.location}`).className='small'
    }
    if (!state.confirmed && (state.status !== 'screening' || state.leaseExpired)) {
      action(state.status === 'pending_screening' ? 'Screen this revision' : 'Screen again', 'screening')
    }
    if (state.status === 'screening') {
      const refreshButton=append(panel, 'button', 'Refresh screening status')
      refreshButton.type='button'
      refreshButton.setAttribute('data-review-action','refresh')
      refreshButton.onclick = async () => {
        try { state = await api(`${base}/screening`); render() } catch (error) { message(error.message) }
      }
    }
    if (state.status === 'screening_passed' && !state.preview && !state.rejection) action('Create preview', 'preview')
    if (state.preview) {
      const previewPanel=append(panel,'section','')
      previewPanel.className='request-preview'
      previewPanel.tabIndex=-1
      previewPanel.setAttribute('aria-label','Request preview')
      const heading = append(previewPanel, 'div', '')
      heading.className = 'preview-intro'
      append(heading, 'p', 'REQUEST REVIEW').className = 'preview-eyebrow'
      append(heading, 'h4', 'Review your request')
      append(heading, 'p', 'Check the details below before confirming this request.').className = 'preview-subtitle'
      if(state.preview.content.summary)append(heading,'p',state.preview.content.summary).className = 'preview-summary'
      if (state.preview.content.flowchartMermaid) {
        const mapSection = append(previewPanel, 'section', '')
        mapSection.className = 'preview-flowchart-section'
        append(mapSection, 'p', state.demoExample ? 'ILLUSTRATIVE EXAMPLE' : 'DRAFT WORKFLOW').className = 'preview-eyebrow'
        append(mapSection, 'h4', 'Draft workflow preview — clinical review required')
        append(mapSection, 'p', state.demoExample
          ? 'Example only: this diagram is not generated from your request or guideline.'
          : 'Review the draft and any missing criteria. This is not a clinical approval.').className = 'preview-detail-note'
        const chart = append(mapSection, 'div', 'Loading flowchart…')
        chart.className = 'flowchart-preview'
        const chartSource = state.preview.content.flowchartMermaid
        import('/flowchart-renderer.js').then(({ renderFlowchart }) => renderFlowchart(chart, chartSource))
          .catch(() => { chart.textContent = 'Could not display the flowchart.' })
      }
      append(previewPanel, 'h4', 'Your request details').className = 'preview-details-title'
      append(previewPanel, 'p', 'This summary is what you are confirming. It is not clinical approval.').className = 'preview-detail-note'
      const flow = append(previewPanel, 'ol', '')
      flow.className = 'preview-details-grid'
      const fieldLabels = {goal:'Goal',pathway:'Pathway',targetUsers:'Who will use it',acceptanceCriteria:'What success looks like'}
      for (const [field, value] of Object.entries(state.preview.content.requirements)) {
        const card = append(flow, 'li', '')
        append(card, 'strong', fieldLabels[field] || field)
        append(card, 'p', value)
      }
      append(previewPanel, 'p', `Baseline: ${state.preview.content.baselineVersion}`)
      for (const source of state.preview.content.sources) append(previewPanel, 'p', `Guideline: ${source.filename} · SHA-256 ${source.sha256}`)
      if (state.rejection) append(previewPanel, 'p', `Preview rejected: ${state.rejection.feedback}`)
      if (!state.confirmed && !state.rejection) {
        const label = append(previewPanel, 'label', 'Review feedback (optional) ')
        const feedback = append(label, 'textarea', '')
        feedback.maxLength = 4000
        feedback.setAttribute('data-review-action','review')
        const reject = append(previewPanel, 'button', 'Reject preview and revise')
        reject.type = 'button'
        reject.onclick = () => onCorrect(feedback.value || '')
        const button = append(previewPanel, 'button', 'Confirm this exact revision')
        button.type = 'button'
        button.onclick = async () => {
          button.disabled = true
          message('')
          try {
            state = await api(`${base}/confirmation`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ previewId: state.preview.id, previewHash: state.preview.hash,
                attemptId: state.attemptId, feedback: feedback.value }) })
            render()
          } catch (error) { await reviewError(error); button.disabled = false }
        }
      } else if (state.confirmed) append(previewPanel, 'p', 'Request confirmed. Handoff queued. The downstream workflow has not started.')
      if(revealPreview){parent.open=true;previewPanel.scrollIntoView?.({behavior:'smooth',block:'start'});previewPanel.focus?.({preventScroll:true})}
    }
  }
  render()
}

async function refresh() {
  const sequence=viewSequence
  const revisions = await api('/api/requests')
  if(sequence!==viewSequence)return
  const list = byId('requests')
  list.replaceChildren()
  const latest = new Map()
  for (const revision of revisions.sort((a, b) => b.events[0].at.localeCompare(a.events[0].at))) {
    if (!latest.has(revision.requestId)) latest.set(revision.requestId, revision)
  }
  byId('request-count').textContent = latest.size
  if (!latest.size) {
    const empty = append(list, 'li', '')
    empty.className = 'empty-state'
    append(empty, 'strong', 'A fresh start')
    append(empty, 'span', 'Your submitted requests will appear here.')
  }
  const reviewLabels=new Map()
  for (const revision of latest.values()) {
    const item = append(list, 'li', '')
    append(item, 'button', revision.normalizedRequirements.goal || revision.requestId)
      .onclick = () => show(revision.requestId).catch(error => message(error.message))
    const meta = append(item, 'div', '')
    meta.className = 'request-meta'
    const status = append(meta, 'span', revision.screeningStatus.replaceAll('_', ' '))
    status.className = `status ${revision.screeningStatus}`
    reviewLabels.set(revision.revisionId,status)
    append(meta, 'span', new Date(revision.events[0].at).toLocaleDateString())
  }
  window.chtWorkspace?.loadListReviews([...latest.values()], revision => api(`/api/requests/${revision.requestId}/revisions/${revision.revisionId}/screening`), (revision,label) => { if(sequence===viewSequence)reviewLabels.get(revision.revisionId).textContent=label }, () => sequence===viewSequence)
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
    await refresh()
    navigate('/requests')
    await show(revision.requestId)
    message(`Revision saved with status ${revision.screeningStatus}.`)
    attempt = undefined
    byId('new-request').click()
  } catch (error) {
    if(error.status===409) { try {await refresh()} catch {} }
    message(error.status===409 ? `${error.message} Saved requests refreshed. Review the request or start fresh before submitting again.` : error.message)
  } finally {
    button.disabled = false
  }
})

byId('new-request').onclick = () => {
  form.reset()
  attempt = undefined
  requestId = undefined
  byId('correction-notice').hidden = true
  byId('correction-items').replaceChildren()
  byId('form-title').textContent = 'New request'
}
byId('profile').onclick = async () => {
  const button = byId('profile')
  button.disabled = true
  try {
    const profile = await api('/api/profile')
    byId('profile-username').textContent = profile.username
    byId('profile-id').textContent = profile.authorId
    byId('profile-roles').textContent = profile.roles
      .map(role => role === 'PO' ? 'Product owner (PO)' : role).join(', ')
    byId('profile-dialog').showModal()
  } catch (error) {
    message(error.message)
  } finally {
    button.disabled = false
  }
}
byId('sign-out').onclick = () => {
  token = undefined
  attempt = undefined
  sessionStorage.removeItem('intake-login')
  sessionStorage.removeItem('intake-return-to')
  byId('signed-in-name').textContent = ''
  byId('profile-dialog').close()
  byId('intake').hidden = true
  byId('account-actions').hidden = true
  form.reset()
  byId('requests').replaceChildren()
  byId('details').replaceChildren()
  viewSequence++
  window.chtWorkspace?.signedOut()
  location.replace('/logout')
}
byId('sign-in').onclick = () => signIn().catch(error => message(error.message))
byId('sign-in-again').onclick = () => signIn().catch(error => message(error.message))

// Back navigation must not restore a signed-in page and its in-memory token.
window.addEventListener('pageshow', event => {
  if (event.persisted) location.reload()
})

window.chtWorkspace?.connect({
  navigate: (path, replace) => {
    if (/^\/requests\/[a-f0-9-]{36}$/.test(path)) return show(path.split('/').pop(), replace).catch(error => message(error.message))
    else { navigate(path, replace); if(path==='/requests')refresh().catch(error=>message(error.message)) }
  },
  newRequest: attachment => {byId('new-request').click();navigate('/requests/new');byId(attachment?'attachment':'goal').focus();byId(attachment?'attachment':'goal').scrollIntoView?.({block:'center'})},
  loadRequests: () => api('/api/requests'),
  loadReview: revision => api(`/api/requests/${revision.requestId}/revisions/${revision.revisionId}/screening`),
  cancelPending: () => {viewSequence++}
})

try {
  const query = new URLSearchParams(location.search)
  if (location.pathname === '/signed-out') {
    sessionStorage.removeItem('intake-login')
    byId('welcome').hidden = true
    byId('page-heading').hidden = true
    byId('signed-out').hidden = false
    signOutRedirect = setTimeout(() => location.replace('/'), 5000)
  }
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
    byId('account-actions').hidden = false
    const profile = await api('/api/profile')
    byId('signed-in-name').textContent = profile.username
    await window.chtWorkspace?.authenticated(profile)
    const versions = await api('/api/versions')
    for (const version of versions) form.elements.baselineVersion.add(new Option(version, version))
    await refresh()
    byId('welcome').hidden = true
    byId('intake').hidden = false
    const returnTo = sessionStorage.getItem('intake-return-to')
    sessionStorage.removeItem('intake-return-to')
    if (window.chtWorkspace) window.chtWorkspace.start(safeReturnPath(returnTo))
    else if (/^\/requests\/[a-f0-9-]{36}$/.test(returnTo || '')) await show(returnTo.split('/').pop(), true)
    else navigate(returnTo === '/requests/new' ? '/requests/new' : '/requests', true)
  }
} catch (error) {
  message(error.message)
}
