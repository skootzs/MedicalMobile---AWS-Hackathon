// Runs the real Worker through real containers for COMPILE_LOGIC then VERIFY_BUILD, against
// DynamoDB Local and the R5 fixture. Not part of `npm test`, because it needs both images,
// a compiler checkout and a built verifier. Driven by scripts/kiro/29-verify-stage-e2e.sh.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dockerStages } from '../launch-build.ts';
import { canonicalJson, sha256 } from '../src/hashing.ts';
import { Worker } from '../src/worker.ts';
import { createTable, Harness } from './helpers.ts';

const { COMPILE_IMAGE, BUILD_IMAGE, COMPILER_ROOT, RUNNER_WORK_DIR, VERIFIER_DIR, VERIFIER_COMMIT, GOLDEN_FILE } = process.env;
if (!COMPILE_IMAGE || !BUILD_IMAGE || !COMPILER_ROOT || !RUNNER_WORK_DIR || !VERIFIER_DIR || !VERIFIER_COMMIT || !GOLDEN_FILE) {
  throw new Error('Set COMPILE_IMAGE, BUILD_IMAGE, COMPILER_ROOT, RUNNER_WORK_DIR, VERIFIER_DIR, VERIFIER_COMMIT and GOLDEN_FILE');
}

mkdirSync(RUNNER_WORK_DIR, { recursive: true });
chmodSync(RUNNER_WORK_DIR, 0o755);
const workRoot = mkdtempSync(join(RUNNER_WORK_DIR, 'e2e-'));
chmodSync(workRoot, 0o755);

const h = new Harness(createTable());
const fixture = JSON.parse(readFileSync(new URL('./fixtures/child-cough.logic.json', import.meta.url), 'utf8'));
const envelope = canonicalJson({ kind: 'LOGIC_MODEL', revision: 1, content: fixture });
const hash = sha256(envelope);
const snapshotUri = h.artifacts.seed(`snapshots/${hash}.json`, envelope);

const worker = new Worker({
  config: h.config({
    compileImage: COMPILE_IMAGE,
    buildImage: BUILD_IMAGE,
    compilerDir: join(COMPILER_ROOT, 'packages/compiler'),
    templateDir: join(COMPILER_ROOT, 'templates/cht-base'),
    verifierDir: VERIFIER_DIR,
    verifierCommit: VERIFIER_COMMIT,
    workRoot,
  }),
  store: h.store(),
  queue: h.queue,
  artifacts: h.artifacts,
  stages: dockerStages,
  log: (level, message, detail) => console.log(level, message, detail ?? ''),
});

async function run(payload: Record<string, unknown>) {
  await h.seedJob(payload as { jobId: unknown; requestId: unknown });
  const outcome = await worker.handle(h.message(payload));
  const job = await h.job(payload.jobId);
  console.log(JSON.stringify({ outcome, status: job.status, errorCode: job.errorCode, errorMessage: job.errorMessage, lastErrorCode: job.lastErrorCode, lastErrorMessage: job.lastErrorMessage, verificationPassed: job.verificationPassed }));
  assert.equal(outcome, 'SUCCEEDED');
  return job;
}

const compiled = await run(h.payload({ logicModelHash: hash, snapshotUri }));

async function verify(extra: Record<string, unknown>) {
  const payload: Record<string, unknown> = h.payload({
    jobType: 'VERIFY_BUILD', logicModelHash: hash, snapshotUri, compileJobId: 'compile-e2e', packageUri: compiled.packageUri,
    packageHash: compiled.packageHash, compileArtifactHash: compiled.compileArtifactHash, manifestHash: compiled.manifestHash, ...extra,
  });
  delete payload.mode;
  const job = await run(payload);
  const report = JSON.parse((await h.artifacts.get(job.reportUri)).toString('utf8'));
  const check = (name: string) => (report.integrityChecks as { name: string; ok: boolean; detail: string }[]).find((item) => item.name === name);

  assert.equal(job.reportVersion, '2.3.0');
  assert.equal(check('logicModelHash')?.ok, true, check('logicModelHash')?.detail);
  assert.equal(check('inputHash')?.ok, true, check('inputHash')?.detail);
  assert.equal(check('compileArtifactHash')?.ok, true, check('compileArtifactHash')?.detail);
  assert.equal(check('toolVersionsKnown')?.ok, true, check('toolVersionsKnown')?.detail);
  assert.equal(report.references.logicModelHash, hash);
  assert.notEqual(report.references.logicModelHash, compiled.inputHash);
  assert.equal(report.packageHash, compiled.packageHash);
  assert.ok(report.cases.length > 0, 'the verifier ran no cases');
  return report;
}

const plain = await verify({});
assert.equal(plain.goldenCasesHash, null);
assert.ok(!plain.cases.some((item: { id: string }) => item.id.startsWith('golden/')));

const golden = readFileSync(GOLDEN_FILE);
const withGolden = await verify({ goldenCasesUri: h.artifacts.seed('sources/golden-cases.json', golden), goldenCasesHash: `sha256:${sha256(golden)}` });
assert.equal(withGolden.goldenCasesHash, sha256(golden));
assert.equal((withGolden.integrityChecks as { name: string; ok: boolean }[]).find((item) => item.name === 'goldenCasesHashExpected')?.ok, true);
assert.ok(withGolden.cases.some((item: { id: string }) => item.id.startsWith('golden/')));

console.log(`VERIFY_E2E_OK passed=${String(plain.passed)} withGoldenPassed=${String(withGolden.passed)}`);
