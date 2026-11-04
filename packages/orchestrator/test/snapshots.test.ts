import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalizeJson, createSnapshot, HASH_POLICY_VERSION, logicModelIdentity,
  provisionalSnapshotValidator, requestPreviewIdentity, SnapshotError } from '../src/snapshots.ts';
import type { SnapshotDraft, SnapshotValidator } from '../src/snapshots.ts';
import { transitionWorkflow } from '../src/workflow.ts';

function previewContent() {
  return { title: 'Fictional training checklist', objective: 'Record a training visit.', targetPopulation: 'Fictional households',
    requirements: [{ condition: 'Checklist completed', action: 'Show completion message' }] };
}
function previewDraft(): SnapshotDraft {
  return { kind: 'REQUEST_PREVIEW', requestId: 'fictional-001', revision: 1, schemaVersion: '1.0', content: previewContent() };
}
function modelContent() {
  return { schemaVersion: '1.0', pathwayId: 'training', title: 'Fictional training model', language: 'en',
    sources: [{ id: 'training-guide', title: 'Fictional public training guide', url: 'https://example.org/training', sha256: 'a'.repeat(64) }],
    context: [], questions: [{ id: 'completed', type: 'boolean', label: 'Training checklist completed?', source: 'training-guide' }],
    derived: [], decisionTables: [{ id: 'classification', hitPolicy: 'first',
      rows: [{ when: { eq: ['completed', true] }, outcome: 'finished', source: 'training-guide' }], otherwise: 'unfinished' }],
    outcomes: [{ id: 'finished', label: 'Training complete', referral: 'none' }, { id: 'unfinished', label: 'Training incomplete', referral: 'none' }],
    ambiguities: [{ id: 'training-note', text: 'Fictional wording reviewed.', status: 'resolved', blocking: false,
      sourceRef: 'training-guide', resolution: 'Use checklist wording.' }],
  };
}
function modelDraft(): SnapshotDraft {
  return { kind: 'LOGIC_MODEL', requestId: 'fictional-001', revision: 1, schemaVersion: '1.0', content: modelContent(),
    requestPreview: requestPreviewIdentity(createSnapshot(previewDraft(), provisionalSnapshotValidator)) };
}
const make = (draft: SnapshotDraft) => createSnapshot(draft, provisionalSnapshotValidator);
function invalid(draft: unknown, code?: SnapshotError['code']) {
  assert.throws(() => make(draft as SnapshotDraft), (e: unknown) => e instanceof SnapshotError && (!code || e.code === code));
}

test('snapshot includes explicit immutable metadata and complete content', () => {
  const snapshot = make(modelDraft());
  assert.equal(snapshot.kind, 'LOGIC_MODEL'); assert.equal(snapshot.hashPolicyVersion, HASH_POLICY_VERSION);
  assert.equal(snapshot.requestId, 'fictional-001'); assert.equal(snapshot.revision, 1); assert.equal(snapshot.schemaVersion, '1.0');
  assert.match(snapshot.snapshotHash, /^[a-f0-9]{64}$/);
  assert.equal(canonicalizeJson(snapshot.content), canonicalizeJson(modelContent()));
  assert.equal('approved' in snapshot, false); assert.equal('clinicalApproval' in snapshot, false);
});
test('hash covers the specified canonical envelope, not its own hash field', () => {
  const draft = { kind: 'REQUEST_PREVIEW', requestId: 'x', revision: 1, schemaVersion: 'example', content: { b: 2, a: 1 } } as const;
  const snapshot = createSnapshot(draft, () => {});
  const expected = '{"content":{"a":1,"b":2},"hashPolicyVersion":"jcs-sha256-v1","kind":"REQUEST_PREVIEW","requestId":"x","revision":1,"schemaVersion":"example"}';
  assert.equal(snapshot.snapshotHash, createHash('sha256').update(expected, 'utf8').digest('hex'));
});
test('reordered object keys at all levels produce identical hashes', () => {
  const first = modelDraft();
  function reverse(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reverse);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverse(child)]));
    return value;
  }
  assert.equal(make(first).snapshotHash, make(reverse(first) as SnapshotDraft).snapshotHash);
});
for (const field of ['sources', 'questions', 'decisionTables', 'outcomes', 'ambiguities'] as const) {
  test(`meaningful ${field} changes alter the LogicModel hash`, () => {
    const draft = modelDraft(), content = modelContent();
    if (field === 'sources') content.sources[0].url = 'https://example.org/training-revision';
    if (field === 'questions') content.questions[0].source = 'different-source';
    if (field === 'decisionTables') content.decisionTables[0].rows[0].when.eq[1] = false;
    if (field === 'outcomes') content.outcomes[0].label = 'Changed fictional outcome';
    if (field === 'ambiguities') content.ambiguities[0].text = 'New fictional uncertainty';
    assert.notEqual(make(draft).snapshotHash, make({ ...draft, content }).snapshotHash);
  });
}
test('citation extensions are preserved and hashed rather than silently omitted', () => {
  const draft = modelDraft();
  const content = { ...modelContent(), citations: [{ sourceId: 'training-guide', section: '2' }] };
  const snapshot = make({ ...draft, content });
  assert.equal(canonicalizeJson(snapshot.content.citations), canonicalizeJson(content.citations));
  assert.notEqual(snapshot.snapshotHash, make({ ...draft, content: { ...content, citations: [{ sourceId: 'training-guide', section: '3' }] } }).snapshotHash);
});
test('array order is preserved and changes the hash', () => {
  const draft = modelDraft(), content = modelContent();
  const first = make({ ...draft, content }); content.outcomes.reverse();
  assert.notEqual(first.snapshotHash, make({ ...draft, content }).snapshotHash);
  assert.equal(canonicalizeJson([3, 1, 2]), '[3,1,2]');
});
for (const [key, value] of [['revision', 2], ['requestId', 'fictional-002']] as const) {
  test(`different ${key} changes snapshot hash`, () => {
    const draft = previewDraft(); assert.notEqual(make(draft).snapshotHash, make({ ...draft, [key]: value }).snapshotHash);
  });
}
test('schema versions are hashed and validator integration can be replaced', () => {
  const draft = previewDraft();
  const validator: SnapshotValidator = (content, context) => {
    assert.ok(['1.0', '1.1'].includes(context.schemaVersion)); assert.equal(typeof content.title, 'string');
  };
  assert.notEqual(createSnapshot(draft, validator).snapshotHash, createSnapshot({ ...draft, schemaVersion: '1.1' }, validator).snapshotHash);
  invalid({ ...draft, schemaVersion: '1.1' }, 'SCHEMA_REJECTED');
});
test('preview and LogicModel identities cannot be interchanged', () => {
  const preview = make(previewDraft()), logic = make(modelDraft());
  assert.deepEqual(requestPreviewIdentity(preview), { requestId: preview.requestId, revision: 1, snapshotHash: preview.snapshotHash });
  assert.deepEqual(logicModelIdentity(logic), { logicRevision: 1, logicHash: logic.snapshotHash });
  assert.throws(() => logicModelIdentity(preview)); assert.throws(() => requestPreviewIdentity(logic));
});
test('kind domain separation prevents equal payloads being treated as the same snapshot', () => {
  const draft = previewDraft();
  const preview = createSnapshot(draft, () => {});
  const logic = createSnapshot({ ...draft, kind: 'LOGIC_MODEL', requestPreview: requestPreviewIdentity(preview) }, () => {});
  assert.notEqual(preview.snapshotHash, logic.snapshotHash);
});
test('LogicModel hash binds the exact originating preview', () => {
  const draft = modelDraft();
  const changed = { ...draft, requestPreview: { ...draft.requestPreview!, revision: 2, snapshotHash: 'b'.repeat(64) } };
  assert.notEqual(make(draft).snapshotHash, make(changed).snapshotHash);
  for (const ref of [undefined, null, {}, { ...draft.requestPreview, requestId: 'other' }, { ...draft.requestPreview, snapshotHash: 'invented' },
    { ...draft.requestPreview, extra: true }]) invalid({ ...draft, requestPreview: ref });
});
test('original and nested snapshots cannot silently mutate after hashing', () => {
  const draft = modelDraft(), content = modelContent(), snapshot = make({ ...draft, content });
  const originalHash = snapshot.snapshotHash;
  content.sources[0].url = 'https://example.org/changed';
  assert.notEqual(canonicalizeJson(snapshot.content.sources), canonicalizeJson(content.sources));
  assert.equal(snapshot.snapshotHash, originalHash);
  assert.throws(() => { (snapshot as unknown as Record<string, unknown>).revision = 99; }, TypeError);
  const sources = snapshot.content.sources as readonly Record<string, unknown>[];
  assert.throws(() => { sources[0].url = 'changed'; }, TypeError);
  assert.throws(() => { (sources as unknown[]).push({}); }, TypeError);
  if (snapshot.kind !== 'LOGIC_MODEL') throw new Error('fixture');
  assert.throws(() => { (snapshot.requestPreview as unknown as Record<string, unknown>).revision = 99; }, TypeError);
});
test('validator sees a frozen full copy and cannot strip fields', () => {
  const draft = modelDraft(); let calls = 0;
  createSnapshot(draft, (content, context) => { calls++; assert.ok(Object.isFrozen(content)); assert.ok(Object.isFrozen(context)); assert.ok(content.ambiguities); });
  assert.equal(calls, 1);
  assert.throws(() => createSnapshot(draft, content => { (content as Record<string, unknown>).sources = []; }), SnapshotError);
  assert.throws(() => createSnapshot(draft, (() => ({ changed: true })) as SnapshotValidator), SnapshotError);
  assert.throws(() => createSnapshot(draft, (() => Promise.resolve()) as SnapshotValidator), SnapshotError);
  assert.throws(() => createSnapshot(draft, undefined as unknown as SnapshotValidator), SnapshotError);
});
test('schema rejection fails closed without hashing a transformed value', () => {
  assert.throws(() => createSnapshot(modelDraft(), () => { throw new Error('R4 adapter rejected a reference.'); }), /R4 adapter rejected/);
  invalid({ ...modelDraft(), content: { ...modelContent(), schemaVersion: 'wrong' } }, 'SCHEMA_REJECTED');
  invalid({ ...modelDraft(), content: { ...modelContent(), decisionTables: [] } }, 'SCHEMA_REJECTED');
  invalid({ ...previewDraft(), content: { ...previewContent(), requirements: [] } }, 'SCHEMA_REJECTED');
});
for (const [key, value] of [['revision', 0], ['revision', 1.5], ['revision', Number.MAX_SAFE_INTEGER + 1], ['requestId', ' '],
  ['schemaVersion', ''], ['kind', 'ARTIFACT'], ['snapshotHash', 'fake'], ['hashPolicyVersion', 'custom']] as const) {
  test(`invalid or caller-supplied metadata ${key}=${value} is rejected`, () => invalid({ ...previewDraft(), [key]: value }));
}
test('snapshot drafts and content must be objects', () => {
  for (const content of [null, [], 1, 'raw JSON text']) invalid({ ...previewDraft(), content });
  for (const input of [null, [], 1, 'raw JSON text']) invalid(input);
});
for (const [name, value] of Object.entries({ undefined, nan: NaN, infinity: Infinity, negativeInfinity: -Infinity,
  bigint: 1n, symbol: Symbol('fictional'), function: () => 1, date: new Date(0), map: new Map(), set: new Set(),
  regexp: /x/, bytes: new Uint8Array([1]), boxed: new Number(1) })) {
  test(`unsupported ${name} is rejected instead of converted or omitted`, () => {
    assert.throws(() => canonicalizeJson({ nested: [value] }), SnapshotError);
    invalid({ ...previewDraft(), content: { ...previewContent(), invalid: value } }, 'INVALID_JSON');
  });
}
test('sparse arrays, decorated arrays, cycles, hidden and symbol properties are rejected', () => {
  const extra = Object.assign([1], { extra: 'lost?' });
  const sparse = new Array(1);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
  const symbol = { [Symbol('hidden')]: 1 };
  for (const value of [extra, sparse, cycle, hidden, symbol]) assert.throws(() => canonicalizeJson(value), SnapshotError);
});
test('getters and proxies are rejected without invoking their code', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { calls++; return 1; } });
  const proxy = new Proxy({}, { getPrototypeOf() { calls++; return null; } });
  assert.throws(() => canonicalizeJson(getter), SnapshotError); assert.throws(() => canonicalizeJson(proxy), SnapshotError);
  assert.equal(calls, 0);
});
test('shared references and plain __proto__ properties retain JSON content safely', () => {
  const shared = { key: 1 };
  assert.equal(canonicalizeJson([shared, shared]), '[{"key":1},{"key":1}]');
  assert.equal(canonicalizeJson(JSON.parse('{"__proto__":{"a":1}}')), '{"__proto__":{"a":1}}');
});
test('RFC numeric serialization and UTF-16 sorting examples', () => {
  assert.equal(canonicalizeJson({ numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27] }),
    '{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}');
  assert.equal(canonicalizeJson({ '2': 2, '10': 10 }), '{"10":10,"2":2}');
  assert.equal(canonicalizeJson({ '\ufffd': 1, '😀': 2 }), '{"😀":2,"�":1}');
});
test('finite numeric extremes and negative zero follow JCS IEEE-754 semantics', () => {
  assert.equal(canonicalizeJson([-0, Number.MIN_VALUE, Number.MAX_VALUE, 1e-6, 1e-7]), '[0,5e-324,1.7976931348623157e+308,0.000001,1e-7]');
  const draft = previewDraft();
  assert.equal(make({ ...draft, content: { ...previewContent(), number: -0 } }).snapshotHash,
    make({ ...draft, content: { ...previewContent(), number: 0 } }).snapshotHash);
});
test('Unicode is preserved, escaped correctly, and never normalized', () => {
  assert.equal(canonicalizeJson({ text: 'é😀\n\u000f' }), '{"text":"é😀\\n\\u000f"}');
  const draft = previewDraft();
  assert.notEqual(make({ ...draft, content: { ...previewContent(), label: 'é' } }).snapshotHash,
    make({ ...draft, content: { ...previewContent(), label: 'e\u0301' } }).snapshotHash);
});
test('lone Unicode surrogates in values and keys fail closed', () => {
  for (const value of ['\ud800', '\udc00', '\ud800x', { ['\ud800']: 1 }, ['\udc00']]) assert.throws(() => canonicalizeJson(value), SnapshotError);
});
test('snapshot identity works with the existing workflow without altering it', () => {
  const preview = make(previewDraft()), request = requestPreviewIdentity(preview);
  const result = transitionWorkflow(null, { type: 'SUBMIT', eventId: 'fictional-submit', actor: { id: 'fictional-po', roles: ['PO'] },
    expectedVersion: 0, request, brief: { ...previewContent(), ...request } });
  assert.equal(result.outcome, 'ACCEPTED'); assert.equal(result.state!.status, 'WAITING_FOR_SCREENING');
  assert.equal(result.state!.brief.snapshotHash, preview.snapshotHash); assert.equal(result.state!.clinicalApproval, null);
});
