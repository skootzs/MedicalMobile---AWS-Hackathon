import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { trackingState } from '../ui/src/tracking.js'
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'

const code = (await readFile(new URL('../ui/src/app.js', import.meta.url), 'utf8')).replace("import { trackingState } from '/tracking.js'", '')

async function browser(pathname, search = '', fixtures = {}) {
  const elements = new Map()
  const byId = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: !['welcome', 'page-heading'].includes(id), textContent: '', children: [],
      addEventListener() {}, append(child) { this.children.push(child) },
      setAttribute(name, value) { this[name] = value },
      click() { return this.onclick?.() },
      replaceChildren() { this.children = [] }, reset() {}, focus() { this.focused = true },
      showModal() { this.open = true }, close() { this.open = false },
      elements: { baselineVersion: { add() {} }, goal: {}, pathway: {}, targetUsers: {}, acceptanceCriteria: {}, guidelineUrls: {} }
    })
    return elements.get(id)
  }
  const storage = new Map([['intake-login', JSON.stringify({ state: 'state', verifier: 'verifier' })]])
  const events = new Map()
  const navigation = []
  const requests = []
  const timers = new Map()
  const context = {
    trackingState,
    document: { getElementById: byId, createElement: () => ({ children: [], append(child) { this.children.push(child) }, replaceChildren() { this.children = [] }, setAttribute(name, value) { this[name] = value } }) },
    window: { addEventListener: (name, handler) => events.set(name, handler) },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key) },
    location: { pathname, search, replace: url => navigation.push(url),
      assign: url => navigation.push(url), reload: () => navigation.push('reload') },
    history: {
      replaceState(_state, _title, path) { context.location.pathname = path },
      pushState(_state, _title, path) { context.location.pathname = path }
    }, URLSearchParams, URL, crypto: webcrypto, TextEncoder, btoa,
    setTimeout: (callback, delay) => {
      timers.set(1, { callback, delay })
      return 1
    },
    clearTimeout: id => timers.delete(id),
    fetch: async (path, options) => {
      requests.push({ path, options })
      const bodies = {
        '/api/session': { token: 'token' }, '/api/versions': [], '/api/requests': [],
        '/api/profile': { username: 'po-test', authorId: 'alice', roles: ['PO'] },
        '/api/sign-in': { hostedUrl: 'https://example.auth.us-west-2.amazoncognito.com',
          clientId: 'client', redirectUri: 'http://localhost:3000/' }, ...fixtures
      }
      assert.ok(Object.hasOwn(bodies, path))
      return { ok: true, status: 200, json: async () => typeof bodies[path] === 'function' ? bodies[path](options) : bodies[path] }
    }
  }
  await vm.runInNewContext('(async () => {\n' + code + '\n})()', context)
  return { byId, storage, events, navigation, requests, timers, location: context.location }
}

test('signed-out page confirms logout and sign-in requests fresh credentials with PKCE', async () => {
  const page = await browser('/signed-out')
  assert.equal(page.byId('welcome').hidden, true)
  assert.equal(page.byId('intake').hidden, true)
  assert.equal(page.byId('signed-out').hidden, false)
  assert.equal(page.storage.has('intake-login'), false)
  assert.equal(page.requests.length, 0)
  await page.byId('sign-in-again').onclick()
  assert.equal(page.timers.size, 0)
  const authorize = new URL(page.navigation[0])
  assert.equal(authorize.searchParams.get('prompt'), 'login')
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authorize.searchParams.get('redirect_uri'), 'http://localhost:3000/')
  assert.ok(authorize.searchParams.get('code_challenge'))
  assert.ok(JSON.parse(page.storage.get('intake-login')).verifier)
})

test('logout confirmation returns to the main sign-in page after five seconds', async () => {
  const page = await browser('/signed-out')
  assert.deepEqual(page.navigation, [])
  const timer = page.timers.get(1)
  assert.equal(timer.delay, 5000)
  timer.callback()
  assert.deepEqual(page.navigation, ['/'])
  assert.equal((await browser('/')).timers.size, 0)
})

test('logout clears the local workspace and restored browser pages must reload', async () => {
  const page = await browser('/', '?code=code&state=state')
  assert.equal(page.byId('intake').hidden, false)
  assert.equal(page.byId('signed-in-name').textContent, 'po-test')
  assert.equal(page.requests.at(-1).options.headers.Authorization, 'Bearer token')
  page.byId('sign-out').onclick()
  assert.equal(page.byId('intake').hidden, true)
  assert.equal(page.byId('account-actions').hidden, true)
  assert.equal(page.byId('signed-in-name').textContent, '')
  assert.equal(page.storage.has('intake-login'), false)
  assert.deepEqual(page.byId('requests').children, [])
  assert.deepEqual(page.navigation, ['/logout'])
  page.events.get('pageshow')({ persisted: true })
  assert.deepEqual(page.navigation, ['/logout', 'reload'])
})

test('request navigation separates the form and list and preserves the signed-in identity', async () => {
  const page = await browser('/', '?code=code&state=state')
  assert.equal(page.location.pathname, '/requests')
  assert.equal(page.byId('requests-page').hidden, false)
  assert.equal(page.byId('new-request-page').hidden, true)
  page.byId('nav-new').onclick({ preventDefault() {} })
  assert.equal(page.location.pathname, '/requests/new')
  assert.equal(page.byId('requests-page').hidden, true)
  assert.equal(page.byId('new-request-page').hidden, false)
  assert.equal(page.byId('nav-new')['aria-current'], 'page')
  await page.byId('nav-requests').onclick({ preventDefault() {} })
  assert.equal(page.location.pathname, '/requests')
  assert.equal(page.byId('requests-page').hidden, false)
  assert.equal(page.byId('new-request-page').hidden, true)
  assert.equal(page.byId('signed-in-name').textContent, 'po-test')
  page.location.pathname = '/requests/new'
  page.events.get('popstate')()
  assert.equal(page.byId('new-request-page').hidden, false)
})

const requestId = '11111111-1111-1111-1111-111111111111'
const revision = { requestId, revisionId: '22222222-2222-2222-2222-222222222222',
  normalizedRequirements: { goal: 'Improve follow-up visits' }, baselineVersion: 'v1', sources: [], references: [],
  screeningStatus: 'pending_screening', corrections: [], events: [{ at: '2026-11-04T12:00:00Z', status: 'received' }] }

test('clicking a request opens its connected journey and back restores the list', async () => {
  const page = await browser('/', '?code=code&state=state', {
    '/api/requests': [revision], [`/api/requests/${requestId}`]: [revision],
    [`/api/requests/${requestId}/revisions/${revision.revisionId}/screening`]: { status: 'pending_screening', enabled: false }
  })
  await page.byId('requests').children[0].children[0].onclick()
  assert.equal(page.location.pathname, `/requests/${requestId}`)
  assert.equal(page.byId('requests-overview').hidden, true)
  assert.equal(page.byId('details').hidden, false)
  const tracker = page.byId('details').children.find(child => child.children?.some(item => item.className === 'tracking-route'))
  const stops = tracker.children.find(child => child.className === 'tracking-route').children
  assert.equal(stops.length, 6)
  assert.equal(stops[2]['aria-current'], 'step')
  page.byId('details').children[0].onclick()
  assert.equal(page.location.pathname, '/requests')
  assert.equal(page.byId('requests-overview').hidden, false)
  assert.equal(page.byId('details').hidden, true)
})

test('journey reflects validation, screening, preview and confirmation gates', () => {
  assert.equal(trackingState({ ...revision, screeningStatus: 'blocked' }).current, 1)
  for (const status of ['needs_clarification', 'screening_blocked', 'screening_failed']) {
    const model = trackingState(revision, { status })
    assert.equal(model.current, 2)
    assert.equal(model.steps[2].state, 'attention')
    assert.equal(model.steps[3].state, 'upcoming')
  }
  assert.equal(trackingState(revision, { status: 'screening' }).current, 2)
  assert.equal(trackingState(revision, { status: 'screening_passed' }).current, 3)
  assert.equal(trackingState(revision, { status: 'screening_passed', preview: {} }).current, 4)
  const queued = trackingState(revision, { status: 'screening_passed', preview: {}, confirmed: true })
  assert.equal(queued.current, 5)
  assert.equal(queued.steps[5].state, 'current')
  assert.match(queued.steps[5].description, /has not started/)
  assert.equal(trackingState(revision, { status: 'pending_screening', preview: {}, confirmed: true }).current, 2)
})

test('Screen again posts a fresh screening request after each completed result and displays the new attempt', async () => {
  const path = `/api/requests/${requestId}/revisions/${revision.revisionId}/screening`
  let calls = 0
  const page = await browser('/', '?code=code&state=state', {
    '/api/requests': [revision], [`/api/requests/${requestId}`]: [revision],
    [path]: options => {
      if (options.method === 'POST') calls++
      return { status: calls ? 'screening_passed' : 'needs_clarification', enabled: true,
        attemptId: `attempt-${calls}`, result: { summary: calls ? 'Complete.' : 'More detail.', issues: [] } }
    }
  })
  await page.byId('requests').children[0].children[0].onclick()
  const descendants = element => [element, ...(element.children || []).flatMap(descendants)]
  for (let count = 1; count <= 2; count++) {
    const button = descendants(page.byId('details')).find(element => element.textContent === 'Screen again')
    assert.ok(button)
    await button.onclick()
    assert.equal(calls, count)
    assert.equal(page.requests.at(-1).options.method, 'POST')
    assert.equal(page.requests.at(-1).path, path)
    assert.ok(descendants(page.byId('details')).some(element => element.textContent === `Screening attempt: attempt-${count}`))
  }
})

test('correction form shows current validation and screening changes at the top and clears them for new requests', async () => {
  for (const blocked of [true, false]) {
    const current = { ...revision, screeningStatus: blocked ? 'blocked' : 'pending_screening',
      corrections: blocked ? ['Choose a valid configuration version.'] : [] }
    const page = await browser('/', '?code=code&state=state', {
      '/api/requests': [current], [`/api/requests/${requestId}`]: [current],
      [`/api/requests/${requestId}/revisions/${revision.revisionId}/screening`]: {
        status: 'needs_clarification', enabled: true,
        result: { summary: 'More detail needed', issues: [{ field: 'goal', question: 'Which follow-up outcome is required?' }] }
      }
    })
    await page.byId('requests').children[0].children[0].onclick()
    page.byId('details').children.at(-1).onclick()
    assert.equal(page.location.pathname, '/requests/new')
    assert.equal(page.byId('correction-notice').hidden, false)
    assert.equal(page.byId('correction-notice').focused, true)
    assert.equal(page.byId('request').elements.goal.value, revision.normalizedRequirements.goal)
    assert.equal(page.byId('correction-items').children[0].textContent,
      blocked ? 'Choose a valid configuration version.' : 'Goal: Which follow-up outcome is required?')
    page.byId('nav-new').onclick({ preventDefault() {} })
    assert.equal(page.byId('correction-notice').hidden, true)
    assert.equal(page.byId('correction-items').children.length, 0)
  }
})

const descendants = element => [element, ...(element.children || []).flatMap(descendants)]
const findText = (page, text) => descendants(page.byId('details')).find(element => element.textContent === text)
const completeRevision = { ...revision, normalizedRequirements: {
  goal: 'Improve follow-up visits', pathway: 'COVID routing', targetUsers: 'CHWs', acceptanceCriteria: 'Show follow-up.\nKeep existing rules.'
} }
const lineSuggestions = [
  { id: 'clarify', field: 'acceptanceCriteria', startLine: 1, endLine: 1, original: 'Show follow-up.',
    replacement: 'Show follow-up to CHWs.', kind: 'clarification', rationale: 'CHWs are the named users.' },
  { id: 'assume', field: 'acceptanceCriteria', startLine: 2, endLine: 2, original: 'Keep existing rules.',
    replacement: 'Follow-up timing: [program to supply].', kind: 'assumption', rationale: 'Timing is not supplied.' }
]

test('screening states no longer offer the model revision editor', async () => {
  for (const status of ['screening_passed', 'needs_clarification', 'screening_blocked', 'screening_failed', 'pending_screening', 'screening']) {
    const page = await browser('/', '?code=code&state=state', {
      '/api/requests': [completeRevision], [`/api/requests/${requestId}`]: [completeRevision],
      [`/api/requests/${requestId}/revisions/${revision.revisionId}/screening`]: { status, enabled: true }
    })
    await page.byId('requests').children[0].children[0].onclick()
    assert.equal(findText(page, 'Revise and submit'), undefined)
  }
})

test('reject preview opens the same populated correction form without feedback or a network operation', async () => {
  for (const feedbackText of ['', 'Clarify the follow-up recipient.']) {
    const base = `/api/requests/${requestId}/revisions/${revision.revisionId}`
    const state = { status: 'screening_passed', enabled: true, attemptId: 'attempt',
      result: { summary: 'Checked.', issues: [], suggestions: lineSuggestions },
      preview: { id: 'preview', hash: 'digest', content: { requirements: completeRevision.normalizedRequirements, baselineVersion: 'v1', sources: [] } } }
    const page = await browser('/', '?code=code&state=state', {
      '/api/requests': [completeRevision], [`/api/requests/${requestId}`]: [completeRevision],
      [`${base}/screening`]: state
    })
    await page.byId('requests').children[0].children[0].onclick()
    assert.ok(findText(page, 'Preview'))
    assert.equal(findText(page, 'Request preview'), undefined)
    const feedback = descendants(page.byId('details')).find(element => element.maxLength === 4000)
    feedback.value = feedbackText
    const callsBefore = page.requests.length
    findText(page, 'Reject preview and revise').onclick()
    assert.equal(page.requests.length, callsBefore)
    assert.equal(page.location.pathname, '/requests/new')
    assert.equal(page.byId('page-title').textContent, 'Correct request')
    assert.equal(page.byId('correction-notice').hidden, false)
    assert.equal(page.byId('correction-notice').focused, true)
    for (const [field, value] of Object.entries(completeRevision.normalizedRequirements)) {
      assert.equal(page.byId('request').elements[field].value, value)
    }
    assert.equal(page.byId('request').elements.baselineVersion.value, 'v1')
    if (feedbackText) assert.equal(page.byId('correction-items').children[0].textContent, `Preview feedback: ${feedbackText}`)
    const rejectedForm = Object.fromEntries(Object.entries(page.byId('request').elements).map(([key, value]) => [key, value.value]))
    findText(page, 'Edit').onclick()
    assert.deepEqual(Object.fromEntries(Object.entries(page.byId('request').elements).map(([key, value]) => [key, value.value])), rejectedForm)
  }
})
