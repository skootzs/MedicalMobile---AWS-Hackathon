import test from 'node:test';
import assert from 'node:assert/strict';
import { CompilationResultService } from '../src/compilation-results.ts';
import { normalizeCompilationHashes, r7InitialCompilationStatus } from '../src/compilation-integration.ts';
import { logicObjectBytes } from '../src/compilation-contracts.ts';
import { compilationResultFixture, fixtureBareInputHash, fixtureFileListHash, sha } from './helpers/compilation-result-fixtures.ts';

function rewrite(f: Awaited<ReturnType<typeof compilationResultFixture>>, which: 'manifest' | 'report', change: (v: any) => void) {
  const r = f.source.current!, uri = which === 'manifest' ? r.manifestUri! : r.reportUri!;
  const value = JSON.parse(f.artifacts.objects.get(uri)!.toString()); change(value);
  const bytes = Buffer.from(JSON.stringify(value)); f.artifacts.objects.set(uri, bytes);
  if (which === 'manifest') r.manifestHash = sha(bytes); else r.reportHash = sha(bytes);
}
async function blocked(f: Awaited<ReturnType<typeof compilationResultFixture>>, reason: string) {
  const r = await f.results.ingest(f.commandResult, f.runner); assert.equal(r.reason, reason);
  assert.equal((await f.db.getWorkflow(f.job.requestId))?.status, 'COMPILING');
  assert.equal(await f.db.getCompilationResult(f.job.requestId, f.job.jobId), null);
}

test('canonical S3 envelope bytes contain bare content and hash to the approved snapshot', async () => {
  const f = await compilationResultFixture(), bytes = logicObjectBytes(f.model), envelope = JSON.parse(bytes.toString('utf8'));
  assert.equal(sha(bytes), f.job.logicModelHash); assert.ok(!('snapshotHash' in envelope));
  assert.deepEqual(envelope.content, JSON.parse(JSON.stringify(f.model.content)));
  assert.equal(envelope.revision, f.job.logicModelRevision); assert.equal(envelope.requestPreview.revision, f.job.revision);
  assert.equal(f.source.current!.inputHash, fixtureBareInputHash(envelope.content));
  assert.notEqual(f.source.current!.inputHash, fixtureBareInputHash(envelope));
  assert.notEqual(f.source.current!.inputHash, f.job.logicModelHash);
});
test('test-only bare-input contract sorts object keys recursively without sorting arrays', () => {
  assert.equal(fixtureBareInputHash({ z: [{ b: 2, a: 1 }], a: 'fictional' }), fixtureBareInputHash({ a: 'fictional', z: [{ a: 1, b: 2 }] }));
  assert.notEqual(fixtureBareInputHash({ rows: [1,2] }), fixtureBareInputHash({ rows: [2,1] }));
});
test('test file-list convention hashes sorted path TAB digest NEWLINE entries', () => {
  const entries = [{ path: 'b.properties.json', sha256: 'b'.repeat(64) }, { path: 'a.xlsx', sha256: 'a'.repeat(64) }];
  assert.equal(fixtureFileListHash(entries), sha(`a.xlsx\t${'a'.repeat(64)}\nb.properties.json\t${'b'.repeat(64)}\n`));
});
test('R5 generated-file hash excludes rows and later XML, while full build evidence includes them', async () => {
  const f = await compilationResultFixture(), r = await f.results.ingest(f.commandResult, f.runner), a = r.result!.artifact!;
  const compilerFiles = a.files.filter(file => /\.(xlsx|properties\.json)$/.test(file.path));
  assert.equal(a.generatedFilesHash, fixtureFileListHash(compilerFiles)); assert.equal(a.generatedFilesHash, r.result!.execution.compileArtifactHash);
  assert.notEqual(a.generatedFilesHash, fixtureFileListHash(a.files)); assert.notEqual(a.generatedFilesHash, a.packagedObject.sha256);
  assert.ok(a.files.some(file => file.path.endsWith('.xml'))); assert.ok(a.files.some(file => file.path === 'compile-rows.json'));
});
test('template hash excludes metadata markers and is retained separately from baseline', async () => {
  const f = await compilationResultFixture(), hash = f.artifacts.templateHash();
  f.artifacts.templates.set('.gitkeep', Buffer.from('changed ignored metadata')); f.artifacts.templates.set('.DS_Store', Buffer.from('also ignored'));
  assert.equal(f.artifacts.templateHash(), hash);
  const r = await f.results.ingest(f.commandResult, f.runner); assert.equal(r.status, 'ACCEPTED');
  assert.equal(r.result!.artifact!.templateHash, hash); assert.equal(r.result!.artifact!.manifestVersion, 1);
  assert.ok(!('baselineHash' in f.job)); assert.ok(!('baselineHash' in r.result!));
});
for (const change of [(m: any) => { delete m.manifestVersion; }, (m: any) => { m.manifestVersion = 2; }, (m: any) => { delete m.template; },
  (m: any) => { m.template.hash = 'a'.repeat(64); }]) test(`invalid manifest version/template evidence blocks acceptance: ${change}`, async () => {
  const f = await compilationResultFixture(); rewrite(f, 'manifest', change); await blocked(f, 'MANIFEST_METADATA_MISMATCH');
});
test('R5-only success cannot advance before explicit build conversion/validation evidence', async () => {
  const f = await compilationResultFixture(); f.source.current!.chtConfStatus = 'NOT_RUN';
  const r = await f.results.ingest(f.commandResult, f.runner); assert.equal(r.status, 'BLOCKED'); assert.equal(r.reason, 'BUILD_EVIDENCE_REQUIRED');
  assert.equal(f.artifacts.calls, 0); assert.equal((await f.db.getWorkflow(f.job.requestId))?.status, 'COMPILING');
});
for (const field of ['conversionPassed','validationPassed','toolVersion']) test(`missing build ${field} blocks a success status`, async () => {
  const f = await compilationResultFixture(); rewrite(f, 'report', report => { delete report.build[field]; }); await blocked(f, 'BUILD_EVIDENCE_REQUIRED');
});
test('claimed conversion cannot omit generated XML evidence', async () => {
  const f = await compilationResultFixture(); rewrite(f, 'report', report => { report.files = report.files.filter((file: any) => !file.path.endsWith('.xml')); });
  await blocked(f, 'BUILD_FILE_COVERAGE_MISMATCH');
});
test('malformed VERIFIED metadata cannot waive the build gate', async () => {
  const f = await compilationResultFixture(); const service = new CompilationResultService({ ...f.deps, artifacts: { async verify(input) {
    const r = await f.artifacts.verify(input); if (r.status !== 'VERIFIED') return r;
    return { status: 'VERIFIED', artifact: { ...r.artifact, build: { ...r.artifact.build, validationPassed: false } } };
  } } });
  assert.equal((await service.ingest(f.commandResult, f.runner)).reason, 'INVALID_ARTIFACT_EVIDENCE');
});
test('semantic R7 hash mapping never assigns compiler-file digest to package alias', () => {
  const normalized = normalizeCompilationHashes({ inputHash: 'a'.repeat(64), compileArtifactHash: 'b'.repeat(64), packageHash: 'c'.repeat(64) });
  assert.equal(normalized.inputHash, 'a'.repeat(64)); assert.equal(normalized.compileArtifactHash, 'b'.repeat(64)); assert.equal(normalized.artifactHash, 'c'.repeat(64));
  assert.throws(() => normalizeCompilationHashes({ inputHash: 'bad', compileArtifactHash: 'b'.repeat(64), packageHash: 'c'.repeat(64) }));
});
test('initial status stays PENDING, which is the status the runner leases', () => {
  assert.equal(r7InitialCompilationStatus('PENDING'), 'PENDING'); assert.throws(() => r7InitialCompilationStatus('RUNNING' as never));
});
test('authoritative generated-files digest mismatch blocks despite correct package bytes', async () => {
  const f = await compilationResultFixture(); f.source.current!.compileArtifactHash = 'a'.repeat(64);
  await blocked(f, 'INVALID_ARTIFACT_EVIDENCE');
});
test('structured model rejection preserves named R5 compiler errors and never advances toward R6', async () => {
  const f = await compilationResultFixture(); const diagnostics = { errors: ['UNSUPPORTED_QUESTION_TYPE','UNSUPPORTED_NODE','UNREACHABLE_OUTCOME','OPEN_BLOCKING_AMBIGUITY'].map(code => ({ code, message: 'Fictional training rejection.' })) };
  Object.assign(f.source.current!, { status: 'FAILED', failureKind: 'COMPILER_REJECTED', compilerExitCode: 1, chtConfStatus: 'NOT_RUN', errorCode: 'MODEL_REJECTED', errorMessage: 'Fictional model rejected.', diagnostics });
  const r = await f.results.ingest(f.commandResult, f.runner); assert.equal(r.result?.outcome, 'FAILED'); assert.deepEqual(r.result?.execution.diagnostics, diagnostics);
  assert.equal((await f.db.getWorkflow(f.job.requestId))?.status, 'FAILED');
});
