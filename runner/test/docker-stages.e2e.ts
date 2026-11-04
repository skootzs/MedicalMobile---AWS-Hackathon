// Runs the real Worker through real containers (stages 1-4) against DynamoDB Local and
// the R5 fixture. Not part of `npm test`, because it needs both images and a compiler
// checkout. Driven by scripts/kiro/26-runner-e2e.sh.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dockerStages } from '../launch-build.ts';
import { canonicalJson, sha256 } from '../src/hashing.ts';
import { Worker } from '../src/worker.ts';
import { BUCKET, createTable, Harness } from './helpers.ts';

const { COMPILE_IMAGE, BUILD_IMAGE, COMPILER_ROOT, RUNNER_WORK_DIR } = process.env;
if (!COMPILE_IMAGE || !BUILD_IMAGE || !COMPILER_ROOT || !RUNNER_WORK_DIR) {
  throw new Error('Set COMPILE_IMAGE, BUILD_IMAGE, COMPILER_ROOT and RUNNER_WORK_DIR');
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
    workRoot,
  }),
  store: h.store(),
  queue: h.queue,
  artifacts: h.artifacts,
  stages: dockerStages,
  log: (level, message, detail) => console.log(level, message, detail ?? ''),
});

async function build() {
  const payload = h.payload({ logicModelHash: hash, snapshotUri });
  await h.seedJob(payload);
  const outcome = await worker.handle(h.message(payload));
  const job = await h.job(payload.jobId);
  console.log(JSON.stringify({ outcome, status: job.status, errorCode: job.errorCode, lastErrorCode: job.lastErrorCode, lastErrorMessage: job.lastErrorMessage, errorMessage: job.errorMessage }));
  assert.equal(outcome, 'SUCCEEDED');
  return job;
}

const first = await build();
const second = await build();

assert.equal(first.inputHash, sha256(canonicalJson(fixture)));
assert.equal(first.snapshotHash, hash);
assert.equal(first.packageHash, second.packageHash, 'real builds of the same input must give the same packageHash');
const uploaded = h.keys().filter((key) => !key.startsWith('snapshots/'));
for (const suffix of ['forms/app/child_cough.xlsx', 'forms/app/child_cough.xml', 'compile-manifest.json', 'compile-rows.json', 'manifest.json', 'project.tgz', 'convert.log', 'compile.log']) {
  assert.ok(uploaded.some((key) => key.endsWith(suffix)), `missing upload: ${suffix}`);
}
assert.ok(uploaded.every((key) => key.startsWith('previews/')), 'preview build wrote outside previews/');
assert.ok(String(first.packageUri).startsWith(`s3://${BUCKET}/previews/`));
console.log(`RUNNER_E2E_OK packageHash=${String(first.packageHash)} toolVersions=${JSON.stringify(first.toolVersions)}`);
