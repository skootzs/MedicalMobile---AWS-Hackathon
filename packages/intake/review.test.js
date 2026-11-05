import { test } from 'node:test'
import assert from 'node:assert/strict'
import { submit, hash } from './intake.js'
import { createReview } from './review.js'
import { createScreener, screeningConfig, ScreeningBlock, validateResult } from './screening.js'

const config = screeningConfig({ INTAKE_SCREENING_ENABLED: 'true', BEDROCK_MODEL_ID: 'test-model',
  BEDROCK_GUARDRAIL_ID: 'test-guardrail', BEDROCK_GUARDRAIL_VERSION: '1' })
const registry = { v1: hash('baseline') }
const pass = input => ({ decision: 'pass', summary: 'Complete.', issues: [], suggestions: [],
  evidence: [{ source: input.guidelines[0]?.source || input.requirementsSource, location: 'Submitted requirements or excerpt' }] })

async function fixture({ screen, generateFlowchart = async () => 'flowchart TD\n A["Example"]', attachment = true, urls = ['https://example.org/public'], settings = config } = {}) {
  let state, r, head, clock = 0, calls = 0
  const objects = new Map(), events = [], records = new Map(), reservations = new Map()
  const store = {
    async reserve(a, k, proposed) { if (!reservations.has(k)) reservations.set(k, proposed); return reservations.get(k) },
    async source(key, bytes) { objects.set(key, bytes); return { bucket: 'test', key, versionId: '1', sha256: hash(bytes) } },
    async finish(a, k, value, guard) {
      if (guard && (head !== guard.revisionId || state?.version !== guard.phaseVersion)) throw Object.assign(new Error('Stale revision'), { status: 409 })
      r = value; head = r.revisionId; records.set(r.revisionId, r); reservations.get(k).result = r; return r
    },
    async history() { return [...records.values()] },
    async revision(author, request, revision) { return author === 'alice' && request === r.requestId ? records.get(revision) : undefined },
    async readSource(source) { return objects.get(source.key) },
    async phase() { return state && structuredClone(state) },
    async savePhase(author, request, revision, previous, next, event, current) {
      if (previous?.version !== state?.version || current && head !== revision) return null
      state = { ...structuredClone(next), version: (state?.version || 0) + 1 }
      events.push(event)
      return structuredClone(state)
    }
  }
  await submit({ store, registry, author: 'alice', key: 'test-phase-two-key', raw: Buffer.from(JSON.stringify({
    goal: 'Add cough follow-up', pathway: 'Child cough', targetUsers: 'CHWs', acceptanceCriteria: 'Show a follow-up task',
    baselineVersion: 'v1', guidelineUrls: urls,
    ...(attachment && { attachment: { name: 'public.md', base64: Buffer.from('Public synthetic guideline: record follow-up.').toString('base64') } })
  })) })
  const service = (policy = settings) => createReview({ store, registry, config: policy, now: () => clock, generateFlowchart,
    screen: async input => { calls++; return screen ? screen(input) : { result: pass(input) } } })
  const args = () => ['alice', r.requestId, r.revisionId]
  return { service, store, args, objects, events, revision: () => r, calls: () => calls,
    advance: () => { clock += 200000 }, correct: () => { head = 'new-revision' } }
}

test('preview saves one generated diagram and retries a failure without repeating screening', async () => {
  let calls = 0
  const f = await fixture({ generateFlowchart: async () => {
    if (++calls === 1) throw new Error('offline')
    return 'flowchart TD\n A["Example"]'
  } })
  const review = f.service(), args = f.args()
  await review.screen(...args)
  await assert.rejects(review.preview(...args), { status: 503 })
  assert.equal((await review.get(...args)).status, 'screening_passed')
  const result = await review.preview(...args)
  assert.equal(result.preview.content.flowchartMermaid, 'flowchart TD\n A["Example"]')
  assert.deepEqual(await review.preview(...args), result)
  assert.equal(calls, 2)
  assert.equal(f.calls(), 1)
  assert.equal(result.preview.hash, hash(JSON.stringify(result.preview.content)))
})

test('only a verified, screened preview can be confirmed and queued idempotently', async () => {
  const f = await fixture(), review = f.service(), args = f.args()
  await assert.rejects(review.preview(...args), { status: 409 })
  await assert.rejects(review.confirm(...args, {}), { status: 400 })
  assert.equal((await review.screen(...args)).status, 'screening_passed')
  await review.get(...args)
  assert.equal(f.calls(), 1)
  const previewed = await review.preview(...args)
  assert.deepEqual(await review.preview(...args), previewed)
  const input = { previewId: previewed.preview.id, previewHash: previewed.preview.hash, attemptId: previewed.attemptId, feedback: 'Reviewed' }
  await assert.rejects(review.confirm(...args, { ...input, previewHash: 'forged' }), { status: 409 })
  const confirmed = await review.confirm(...args, input)
  assert.equal(confirmed.confirmed, true)
  assert.equal(confirmed.handoff, 'queued')
  assert.deepEqual(await review.confirm(...args, input), confirmed)
  await assert.rejects(review.screen(...args), { status: 409 })
  assert.equal((await review.get(...args)).handoff, 'queued')
  f.correct()
  await assert.rejects(review.confirm(...args, input), { status: 409 })
})

test('policy changes invalidate previews and confirmation; ownership applies to every action', async () => {
  const f = await fixture(), review = f.service(), args = f.args()
  await review.screen(...args)
  const p = await review.preview(...args)
  const changed = f.service({ ...config, fingerprint: 'new-policy' })
  assert.equal((await changed.get(...args)).status, 'pending_screening')
  await assert.rejects(changed.confirm(...args, { previewId: p.preview.id, previewHash: p.preview.hash, attemptId: p.attemptId, feedback: '' }), { status: 409 })
  for (const method of ['get', 'screen', 'preview', 'confirm']) {
    await assert.rejects(review[method]('bob', args[1], args[2], {}), { status: 404 })
  }
})

test('requests with links or no supporting evidence invoke the model without requiring an upload', async () => {
  for (const urls of [['https://example.org/public'], []]) {
    const f = await fixture({ attachment: false, urls, screen: input => {
      assert.deepEqual(input.guidelines, [])
      assert.deepEqual(input.guidelineUrls, urls)
      assert.ok(input.requirementsSource.endsWith('/submission.json'))
      return { result: pass(input) }
    } })
    assert.equal(f.revision().screeningStatus, 'pending_screening')
    const state = await f.service().screen(...f.args())
    assert.equal(state.status, 'screening_passed')
    assert.equal(f.calls(), 1)
  }
})

test('each explicit screening after completion invokes the model and replaces the attempt and preview', async () => {
  let calls = 0
  const f = await fixture({ screen: input => ({ result: ++calls === 2 ? {
    decision: 'needs_clarification', summary: 'Specify the timing.',
    issues: [{ code: 'TIMING', field: 'acceptanceCriteria', question: 'When is the task due?' }], evidence: []
  } : pass(input) }) })
  const review = f.service(), args = f.args()
  const first = await review.screen(...args)
  const preview = await review.preview(...args)
  const second = await review.screen(...args)
  assert.equal(second.status, 'needs_clarification')
  assert.notEqual(first.attemptId, second.attemptId)
  assert.equal(second.preview, null)
  assert.equal(f.calls(), 2)
  await assert.rejects(review.confirm(...args, { previewId: preview.preview.id, previewHash: preview.preview.hash,
    attemptId: first.attemptId, feedback: '' }), { status: 409 })
  assert.equal((await review.screen(...args)).status, 'screening_passed')
  assert.equal(f.calls(), 3)
  assert.equal(f.events.filter(event => event.type === 'screening_started').length, 3)
})

test('a corrected revision is screened from its new submitted content without reusing an old result', async () => {
  const seen = []
  const f = await fixture({ attachment: false, screen: input => {
    seen.push(input.requirements.acceptanceCriteria)
    return { result: seen.length === 1 ? {
      decision: 'needs_clarification', summary: 'Specify timing.',
      issues: [{ code: 'TIMING', field: 'acceptanceCriteria', question: 'When is the task due?' }], evidence: []
    } : pass(input) }
  } })
  const review = f.service()
  const original = f.revision()
  assert.equal((await review.screen(...f.args())).status, 'needs_clarification')
  await submit({ store: f.store, registry, author: 'alice', requestId: original.requestId, key: 'corrected-request-key',
    raw: Buffer.from(JSON.stringify({ ...original.normalizedRequirements,
      acceptanceCriteria: 'Show a follow-up task due in 48 hours', baselineVersion: 'v1' })) })
  assert.notEqual(f.revision().revisionId, original.revisionId)
  assert.equal((await review.screen(...f.args())).status, 'screening_passed')
  assert.deepEqual(seen, ['Show a follow-up task', 'Show a follow-up task due in 48 hours'])
})

test('tampered evidence, oversized input, and guardrail interventions never pass', async () => {
  const f = await fixture()
  f.objects.set(f.revision().sources[0].key, Buffer.from('modified submission'))
  assert.equal((await f.service().screen(...f.args())).status, 'screening_blocked')
  assert.equal(f.calls(), 0)
  const large = await fixture({ settings: { ...config, maxInputBytes: 10 } })
  assert.equal((await large.service().screen(...large.args())).status, 'screening_blocked')
  const blocked = await fixture({ screen: () => { throw new ScreeningBlock('GUARDRAIL_INTERVENED') } })
  assert.equal((await blocked.service().screen(...blocked.args())).status, 'screening_blocked')
})

test('failures expose transient classification and explicit screening retries make new calls', async () => {
  for (const [name, retryable] of [['ThrottlingException', true], ['AccessDeniedException', false]]) {
    const f = await fixture({ screen: () => { throw Object.assign(new Error('private error'), { name }) } })
    const review = f.service()
    const result = await review.screen(...f.args())
    assert.equal(result.status, 'screening_failed')
    assert.equal(result.retryable, retryable)
    assert.ok(!JSON.stringify(result).includes('private error'))
    await review.screen(...f.args())
    assert.equal(f.calls(), 2)
  }
})

test('active leases suppress duplicates and expired responses cannot overwrite new attempts', async () => {
  const pending = []
  const f = await fixture({ screen: input => new Promise(resolve => pending.push(() => resolve({ result: pass(input) }))) })
  const review = f.service()
  const first = review.screen(...f.args())
  while (!pending.length) await new Promise(resolve => setImmediate(resolve))
  assert.equal((await review.screen(...f.args())).status, 'screening')
  assert.equal(f.calls(), 1)
  f.advance()
  const second = review.screen(...f.args())
  while (pending.length < 2) await new Promise(resolve => setImmediate(resolve))
  pending[1]()
  assert.equal((await second).status, 'screening_passed')
  pending[0]()
  await assert.rejects(first, { status: 409 })
  assert.equal((await review.get(...f.args())).status, 'screening_passed')
})

test('strict model schema rejects fabricated references, extra authority, and contradictory dispositions', () => {
  const valid = { decision: 'pass', summary: 'Complete', issues: [], evidence: [{ source: 's1', location: 'line 1' }] }
  for (const invalid of [ { ...valid, authorId: 'admin' }, { ...valid, evidence: [] },
    { ...valid, evidence: [{ source: 'invented', location: 'line 1' }] },
    { ...valid, decision: 'needs_clarification' },
    { ...valid, issues: [{ code: 'MISSING', field: 'goal', question: 'Which goal?' }] } ]) {
    assert.throws(() => validateResult(invalid, ['s1']))
  }
})

test('Bedrock adapter applies input guardrails, sends separated instructions and validates output', async () => {
  const commands = []
  const input = { guidelines: [{ source: 's1', text: 'Public guideline' }] }
  const client = { async send(command) {
    commands.push(command)
    return commands.length === 1 ? { action: 'NONE' } : {
      stopReason: 'end_turn', output: { message: { content: [
        { reasoningContent: { redactedContent: new Uint8Array([1, 2]) } },
        { text: JSON.stringify(pass(input)) }
      ] } },
      usage: { inputTokens: 12, outputTokens: 20 }
    }
  } }
  const output = await createScreener(config, client)(input)
  assert.equal(output.result.decision, 'pass')
  assert.equal(commands[0].input.source, 'INPUT')
  assert.equal(commands[1].input.guardrailConfig.guardrailVersion, '1')
  // GPT-5.6 rejects temperature; leave sampling settings at the model defaults.
  assert.deepEqual(commands[1].input.inferenceConfig, { maxTokens: config.maxTokens })
  assert.deepEqual(commands[1].input.messages[0].content[0].guardContent.text.qualifiers, ['guard_content'])
  assert.ok(commands[1].input.system[0].text.includes('untrusted'))
})

test('adapter stops on intervention, truncation, invalid JSON, unexpected blocks, or missing configuration', async () => {
  assert.throws(() => screeningConfig({ INTAKE_SCREENING_ENABLED: 'true' }))
  for (const outcome of ['blocked', 'truncated', 'json', 'tool', 'reasoning-only']) {
    let calls = 0
    const client = { async send() {
      calls++
      if (calls === 1) return { action: outcome === 'blocked' ? 'GUARDRAIL_INTERVENED' : 'NONE' }
      const content = outcome === 'tool' ? [{ toolUse: { toolUseId: 'unexpected', name: 'unexpected', input: {} } }]
        : outcome === 'reasoning-only' ? [{ reasoningContent: { redactedContent: new Uint8Array([1]) } }]
          : [{ text: 'not JSON' }]
      return { stopReason: outcome === 'truncated' ? 'max_tokens' : 'end_turn', output: { message: { content } } }
    } }
    await assert.rejects(createScreener(config, client)({ guidelines: [] }))
    assert.equal(calls, outcome === 'blocked' ? 1 : 2)
  }
})

const suggestion = (kind = 'clarification') => ({ id: 'followup', field: 'acceptanceCriteria', startLine: 1, endLine: 1,
  original: 'Show a follow-up task', replacement: 'Display the follow-up task to the community health worker.',
  kind, rationale: 'The request identifies CHWs as the target users.' })

test('line suggestions are available for pass and clarification and corrections preserve sources and require new screening', async () => {
  for (const decision of ['pass', 'needs_clarification']) {
    const f = await fixture({ screen: input => ({ result: { ...pass(input), decision,
      issues: decision === 'pass' ? [] : [{ code: 'DETAIL', field: 'acceptanceCriteria', question: 'Clarify who sees the task.' }],
      suggestions: [suggestion()] } }) })
    const review = f.service(), args = f.args(), original = f.revision()
    const state = await review.screen(...args)
    const input = { attemptId: state.attemptId, selections: [{ id: 'followup', replacement: suggestion().replacement }] }
    const revised = await review.revise(...args, input, 'revision-suggestions-key')
    assert.notEqual(revised.revisionId, original.revisionId)
    assert.equal(revised.requestId, original.requestId)
    assert.equal(revised.screeningStatus, 'pending_screening')
    assert.equal(revised.normalizedRequirements.goal, original.normalizedRequirements.goal)
    assert.equal(revised.normalizedRequirements.acceptanceCriteria, suggestion().replacement)
    assert.equal(revised.sources.find(item => item.filename)?.sha256, original.sources.find(item => item.filename)?.sha256)
    assert.deepEqual(revised.references.map(item => item.url), original.references.map(item => item.url))
    assert.equal((await review.revise(...args, input, 'revision-suggestions-key')).revisionId, revised.revisionId)
    assert.ok(f.events.some(event => event.type === 'revision_suggestions_selected'))
  }
})

test('assumptions require explicit acceptance; stale attempts, unknown choices, and content-blocked results cannot be revised', async () => {
  const f = await fixture({ screen: input => ({ result: { ...pass(input), suggestions: [suggestion('assumption')] } }) })
  const review = f.service(), args = f.args(), state = await review.screen(...args)
  const input = { attemptId: state.attemptId, selections: [{ id: 'followup', replacement: 'A user supplied deadline.' }] }
  await assert.rejects(review.revise(...args, input, 'assumption-test-key'), { status: 400 })
  await assert.rejects(review.revise(...args, { ...input, attemptId: 'old' }, 'assumption-test-key'), { status: 409 })
  await assert.rejects(review.revise(...args, { ...input, selections: [{ id: 'forged', replacement: 'text' }] }, 'assumption-test-key'), { status: 400 })
  const revised = await review.revise(...args, { ...input, selections: [{ ...input.selections[0], acceptAssumption: true }] }, 'assumption-test-key')
  assert.equal(revised.normalizedRequirements.acceptanceCriteria, 'A user supplied deadline.')
  const blocked = await fixture({ screen: () => { throw new ScreeningBlock('GUARDRAIL_INTERVENED') } })
  const blockedState = await blocked.service().screen(...blocked.args())
  await assert.rejects(blocked.service().revise(...blocked.args(), { attemptId: blockedState.attemptId, selections: [] }, 'blocked-content-key'), { status: 409 })
})

test('preview rejection is audited, prevents confirmation, and feeds the next screening', async () => {
  let feedback
  const f = await fixture({ screen: input => { feedback = input.previewFeedback; return { result: pass(input) } } })
  const review = f.service(), args = f.args()
  await review.screen(...args)
  const state = await review.preview(...args)
  const input = { attemptId: state.attemptId, previewId: state.preview.id, previewHash: state.preview.hash, feedback: 'Clarify the follow-up recipient.' }
  await assert.rejects(review.reject(...args, { ...input, previewHash: 'stale' }), { status: 409 })
  const rejected = await review.reject(...args, input)
  assert.equal(rejected.rejection.feedback, input.feedback)
  assert.equal(rejected.confirmed, false)
  await assert.rejects(review.confirm(...args, input), { status: 409 })
  await assert.rejects(review.preview(...args), { status: 409 })
  assert.ok(f.events.some(event => event.type === 'preview_rejected'))
  await review.screen(...args)
  assert.equal(feedback, input.feedback)
})

test('model edits must match exact original lines and cannot overlap or edit baseline fields', () => {
  const requirements = { goal: 'Goal', pathway: 'Path', targetUsers: 'CHWs', acceptanceCriteria: 'Show a follow-up task' }
  const result = { decision: 'pass', summary: 'Complete.', issues: [], evidence: [{ source: 's', location: 'request' }], suggestions: [suggestion()] }
  assert.doesNotThrow(() => validateResult(result, ['s'], requirements))
  for (const edit of [{ original: 'different' }, { startLine: 0 }, { endLine: 2 }, { kind: 'safe' }, { field: 'baselineVersion' }]) {
    assert.throws(() => validateResult({ ...result, suggestions: [{ ...suggestion(), ...edit }] }, ['s'], requirements))
  }
  assert.throws(() => validateResult({ ...result, suggestions: [suggestion(), { ...suggestion(), id: 'overlap' }] }, ['s'], requirements))
})
