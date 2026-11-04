// Acceptance tests for Role 3's first milestone. No AWS needed: model answers are replayed from files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { draftLogicModel } from '../src/draft.ts';
import { practiceClient } from '../src/bedrock.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const GUIDELINE = readFileSync(here('../../../fixtures/child-cough/guideline.md'), 'utf8');
const REC = (name: string) => here(`./fixtures/recorded/${name}`);
const REQUEST = 'Create a CHW form for children 2 months up to 5 years with cough or difficult breathing.';

async function run(recorded: string[], opts: { guideline?: string; request?: string; promptVersion?: string } = {}) {
  return draftLogicModel({
    guidelineMarkdown: opts.guideline ?? GUIDELINE,
    request: opts.request ?? REQUEST,
    client: practiceClient(recorded.map(REC)),
    promptVersion: opts.promptVersion,
  });
}

async function compilerAvailable(): Promise<boolean> {
  try {
    const m = (await import('../../compiler/src/index.ts')) as Record<string, unknown>;
    return typeof m.compileLogicModel === 'function';
  } catch {
    return false;
  }
}

test('1. missing threshold in the guideline is never silently filled', async () => {
  const guideline = GUIDELINE.replace(/40 breaths per minute or more/g, 'breaths per minute or more');
  assert.notEqual(guideline, GUIDELINE, 'fixture edit must change the guideline');
  const { logic, envelope } = await run(['good.json'], { guideline });
  assert.equal(envelope.compilable, false);
  const missing = (logic!.ambiguities as { text: string; blocking: boolean }[])
    .filter((a) => a.blocking && a.text.startsWith('Missing threshold') && a.text.includes('40'));
  assert.equal(missing.length, 1, 'value 40 must become a blocking "Missing threshold" ambiguity');
});

test('1b. a threshold the model invented (45) is flagged and blocks', async () => {
  const { envelope } = await run(['invented-threshold.json']);
  assert.ok(envelope.numbers.some((n) => n.value === 45 && !n.found));
  assert.equal(envelope.compilable, false);
  assert.equal(envelope.screening.clinicalSafety.status, 'flag');
});

test('2a. malformed model output is rejected after one retry', async () => {
  const { logic, envelope } = await run(['malformed.txt']);
  assert.equal(logic, null);
  assert.equal(envelope.status, 'blocked');
  assert.equal(envelope.blockers[0]?.kind, 'schema_failure');
  assert.equal(envelope.usage.length, 2, 'one try plus one retry, both recorded');
});

test('2b. schema-violating output is rejected with the reason', async () => {
  const { logic, envelope } = await run(['schema-violation.json']);
  assert.equal(logic, null);
  assert.match(envelope.blockers[0]!.reasons.join(' '), /decisionTables/);
});

test('2c. a bad first answer followed by a good one succeeds on the retry', async () => {
  const { logic, envelope } = await run(['malformed.txt', 'good.json']);
  assert.ok(logic);
  assert.equal(envelope.status, 'proposed');
  assert.deepEqual(envelope.usage.map((u) => u.attempt), [1, 2]);
});

test('3. a quote that is not in the guideline is flagged as an unsupported claim', async () => {
  const { logic, envelope } = await run(['fake-quote.json']);
  const bad = envelope.citations.find((c) => c.elementId === 'fast_breathing');
  assert.equal(bad?.verified, false);
  assert.equal(bad?.problem, 'quote_not_found');
  assert.ok((logic!.ambiguities as { text: string; blocking: boolean }[])
    .some((a) => a.blocking && a.text.startsWith('Unsupported claim')));
});

test('3b. correct quotes all verify, so only true clinical questions block', async () => {
  const { envelope } = await run(['good.json']);
  assert.deepEqual(envelope.citations.filter((c) => !c.verified), []);
  assert.ok(envelope.numbers.every((n) => n.found));
  assert.deepEqual(envelope.addedAmbiguityIds, []);
  assert.deepEqual(envelope.openBlockingAmbiguities, ['A1']);
});

test('4a. a question without source.page and source.quote triggers one retry with the error', async () => {
  const { envelope } = await run(['no-source.json', 'good.json']);
  assert.equal(envelope.usage.length, 2);
  assert.deepEqual(envelope.addedAmbiguityIds, [], 'retry supplied the missing source');
});

test('4b. if the retry still has no source, it becomes a blocking ambiguity', async () => {
  const { logic, envelope } = await run(['no-source.json']);
  assert.equal(envelope.status, 'proposed');
  const added = (logic!.ambiguities as { text: string; blocking: boolean }[])
    .filter((a) => a.text.startsWith('No citation') && a.text.includes('breaths_per_minute'));
  assert.equal(added.length, 1);
  assert.equal(added[0]!.blocking, true);
});

test('5a. placeholder guideline text is unusable and no model call is made', async () => {
  const { envelope } = await run(['good.json'], { guideline: '# T\n\n## Page 5\n<paste page 5 text>\n' });
  assert.equal(envelope.blockers[0]?.kind, 'unusable_source');
  assert.equal(envelope.usage.length, 0);
});

test('5b. a request with personal data is stopped before the model', async () => {
  const { envelope } = await run(['good.json'], { request: "Child's name is Amina, phone +254 712 345 678" });
  assert.equal(envelope.blockers[0]?.kind, 'personal_data');
  assert.equal(envelope.usage.length, 0);
});

test('7. provenance records source, prompt and model; prompt version changes the record', async () => {
  const a = (await run(['good.json'])).envelope.provenance;
  const b = (await run(['good.json'], { promptVersion: 'draft-test' })).envelope.provenance;
  for (const p of [a, b]) {
    assert.ok(p.guidelineTextSha256 && p.promptSha256 && p.modelId && p.extractorVersion && p.logicSha256);
  }
  assert.equal(a.sourcePdfSha256, 'd10fd1d040bdbdb6db4254b8095e1d1722d0a3d2f80c3651b3003301a8a6959f');
  assert.notEqual(a.promptVersion, b.promptVersion);
});

test('format proof: once a clinician resolves the ambiguities, the Role 5 compiler accepts the draft', async (t) => {
  if (!(await compilerAvailable())) return t.skip('compiler package not on this branch yet');
  const { compileLogicModel } = (await import('../../compiler/src/index.ts')) as {
    compileLogicModel: (x: unknown) => { ok: boolean; errors?: unknown[] };
  };
  const { logic } = await run(['good.json']);
  const resolved = structuredClone(logic!) as { ambiguities: { status: string; resolution?: string }[] };
  for (const a of resolved.ambiguities) {
    a.status = 'resolved';
    a.resolution = 'Test only: simulated clinician decision';
  }
  const result = compileLogicModel(resolved);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('format proof via the CLI: open blocking ambiguity exits 1, resolved draft exits 0', async (t) => {
  if (!(await compilerAvailable())) return t.skip('compiler package not on this branch yet');
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const cli = here('../../compiler/src/cli.ts');
  const dir = mkdtempSync(join(tmpdir(), 'r3-'));
  const { logic } = await run(['good.json']);
  writeFileSync(join(dir, 'draft.json'), JSON.stringify(logic));
  const open = spawnSync(process.execPath, [cli, join(dir, 'draft.json'), '--out', join(dir, 'x1')], { encoding: 'utf8' });
  assert.equal(open.status, 1);
  assert.match(open.stderr, /OPEN_BLOCKING_AMBIGUITY/);
  const resolved = structuredClone(logic!) as { ambiguities: { status: string; resolution?: string }[] };
  for (const a of resolved.ambiguities) { a.status = 'resolved'; a.resolution = 'Test only: simulated clinician decision'; }
  writeFileSync(join(dir, 'resolved.json'), JSON.stringify(resolved));
  const ok = spawnSync(process.execPath, [cli, join(dir, 'resolved.json'), '--out', join(dir, 'x2')], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
});
