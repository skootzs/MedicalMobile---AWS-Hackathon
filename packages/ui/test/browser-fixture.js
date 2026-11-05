import assert from 'node:assert/strict'
import vm from 'node:vm'
import { trackingState } from '../src/tracking.js'
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'

const code = (await readFile(new URL('../src/app.js', import.meta.url), 'utf8')).replace("import { trackingState } from '/tracking.js'", '')

export async function browser(pathname, search = '', fixtures = {}) {
  const elements = new Map()
  const byId = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: !['welcome', 'page-heading'].includes(id), textContent: '', children: [],
      handlers: {}, addEventListener(name,handler) { this.handlers[name]=handler }, append(child) { this.children.push(child) },
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
    document: { getElementById: byId, createElement: () => ({ children: [], append(child) { this.children.push(child) }, replaceChildren() { this.children = [] }, focus() {this.focused=true}, scrollIntoView() {this.scrolled=true}, setAttribute(name, value) { this[name] = value } }) },
    FormData: class { constructor() {} get(key) {return key==='attachment'?undefined:byId('request').elements[key]?.value || ''} entries(){return ['goal','pathway','targetUsers','acceptanceCriteria','baselineVersion','guidelineUrls'].map(key=>[key,this.get(key)])[Symbol.iterator]()} [Symbol.iterator](){return this.entries()} },
    window: { ...(fixtures.workspace && {chtWorkspace:fixtures.workspace}), addEventListener: (name, handler) => events.set(name, handler) },
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
      const value=typeof bodies[path] === 'function' ? await bodies[path](options) : bodies[path]
      return {ok:!value?.httpStatus,status:value?.httpStatus||200,json:async()=>value?.httpStatus?value.body:value}
    }
  }
  await vm.runInNewContext('(async () => {\n' + code + '\n})()', context)
  return { byId, storage, events, navigation, requests, timers, location: context.location }
}

