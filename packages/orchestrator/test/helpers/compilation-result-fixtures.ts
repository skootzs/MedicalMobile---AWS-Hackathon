/** TEST ONLY: opaque verified sessions, fictional runner records and fake byte objects.
 * Hash helpers follow the supplied contract; conformance to actual R5 code still needs a shared fixture. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalizeJson } from '../../src/snapshots.ts';
import type { LogicModelSnapshot } from '../../src/snapshots.ts';
import type { CompilationArtifactVerifier, CompilationExecution, CompilationExecutionSource, ObjectDigest, VerifiedCompilationArtifact } from '../../src/compilation-result-contracts.ts';
import type { CompilationJobIntent } from '../../src/compilation-contracts.ts';
import { CompilationResultService } from '../../src/compilation-results.ts';
import type { CompilationResultCommand, CompilationResultDependencies } from '../../src/compilation-results.ts';
import type { CompilationResultStore } from '../../src/storage/compilation-results.ts';
import type { InMemoryOptions } from '../../src/storage/memory.ts';
import { compilationFixture, wrapCompilationStore } from './compilation-fixtures.ts';
export const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
/** Test-only interpretation of the confirmed bare-JSON contract, not an authoritative R5 implementation. */
export function fixtureBareInputHash(content: unknown): string {
  const sorted = (v: any): any => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
  return sha(JSON.stringify(sorted(content)));
}
export function fixtureFileListHash(files: readonly { path: string; sha256: string }[]): string {
  return sha([...files].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(f => `${f.path}\t${f.sha256}\n`).join(''));
}
export class FictionalExecutions implements CompilationExecutionSource {
  current: CompilationExecution | null = null;
  async getCurrent(requestId: string, jobId: string) { return this.current?.requestId === requestId && this.current.jobId === jobId ? structuredClone(this.current) : null; }
  isCurrent(expected: Readonly<CompilationExecution>) { return canonicalizeJson(this.current) === canonicalizeJson(expected); }
}
export class FictionalArtifacts implements CompilationArtifactVerifier {
  objects = new Map<string, Buffer>();
  files = new Map<string, Buffer>([['forms/app/training.xlsx', Buffer.from('fictional bytes, not a real spreadsheet')],
    ['forms/app/training.properties.json', Buffer.from('{"fictional":true}')], ['compile-rows.json', Buffer.from('["fictional row"]')], ['forms/app/training.xml', Buffer.from('fictional conversion bytes, not an actual CHT form')]]);
  templates = new Map<string, Buffer>([['app_settings.json', Buffer.from('{"fictional":true}')], ['.gitkeep', Buffer.from('ignored')], ['.DS_Store', Buffer.from('ignored')]]);
  templateHash() { return fixtureFileListHash([...this.templates].filter(([path]) => !['.gitkeep','.DS_Store'].includes(path.split('/').at(-1)!)).map(([path,bytes]) => ({ path, sha256: sha(bytes) }))); }
  calls = 0;
  put(name: string, bytes: Buffer): ObjectDigest {
    const uri = `s3://fictional-compiled-objects/${name}`;
    this.objects.set(uri, Buffer.from(bytes));
    return { uri, versionId: 'fictional-version-1', sha256: sha(bytes), size: bytes.length };
  }
  make(job: CompilationJobIntent, model: LogicModelSnapshot): CompilationExecution {
    const allFiles = [...this.files].map(([path, bytes]) => ({ path, sha256: sha(bytes), size: bytes.length }));
    const files = allFiles.filter(f => !f.path.endsWith('.xml'));
    const inputHash = fixtureBareInputHash(model.content);
    const generatedFilesHash = fixtureFileListHash(files.filter(f => /\.(xlsx|properties\.json)$/.test(f.path)));
    const manifest = this.put('compile-manifest.json', Buffer.from(JSON.stringify({ manifestVersion: 1, template: { hash: this.templateHash() }, snapshotHash: model.snapshotHash, inputHash, artifactHash: generatedFilesHash,
      compilerVersion: 'fictional-compiler-v1', schemaVersion: model.schemaVersion, files, options: {}, output: ['fictional-training'], outcomes: [], ambiguities: [] })));
    const pkg = this.put('project.tgz', Buffer.from(`fictional package, not a CHT archive: ${generatedFilesHash}`));
    const report = this.put('compile-report.json', Buffer.from(JSON.stringify({ fictional: true, compilerExitCode: 0, build: { conversionPassed: true, validationPassed: true, toolVersion: 'cht-app-ide:v6.6.1' }, files: allFiles })));
    return { requestId: job.requestId, jobId: job.jobId, jobType: job.jobType, mode: job.mode, attempt: 1, recordVersion: 'fictional-execution-v1', runnerActorId: 'fictional-compiler',
      status: 'SUCCEEDED', requestPreview: job.requestPreview, logicModelRevision: job.logicModelRevision, logicModelHash: job.logicModelHash, clinicalApprovalId: job.clinicalApprovalId,
      jobWorkflowVersion: job.workflowVersion, inputHash, compileArtifactHash: generatedFilesHash, artifactUri: pkg.uri, artifactHash: pkg.sha256, artifactVersionId: pkg.versionId,
      manifestUri: manifest.uri, manifestHash: manifest.sha256, manifestVersionId: manifest.versionId, reportUri: report.uri, reportHash: report.sha256, reportVersionId: report.versionId,
      toolVersions: { compiler: 'fictional-compiler-v1', node: '22', chtConf: 'cht-app-ide:v6.6.1', chtConfNode: '20' }, startedAt: '2026-11-04T12:01:00.000Z', finishedAt: '2026-11-04T12:02:00.000Z',
      compilerExitCode: 0, chtConfStatus: 'PASSED', failureKind: null, errorCode: null, errorMessage: null, logUri: 's3://fictional-compiled-objects/runner.log', diagnostics: null };
  }
  async verify({ job, execution: r, model }: { job: CompilationJobIntent; execution: CompilationExecution; model: LogicModelSnapshot }) {
    this.calls++;
    const invalid = (reason: string) => ({ status: 'INVALID' as const, reason });
    const objects = [['artifactUri','artifactHash','artifactVersionId'],['manifestUri','manifestHash','manifestVersionId'],['reportUri','reportHash','reportVersionId']] as const;
    const verified: ObjectDigest[] = [];
    for (const [uri, hash, version] of objects) {
      const bytes = this.objects.get(r[uri]!);
      if (!bytes) return invalid(uri === 'artifactUri' ? 'ARTIFACT_MISSING' : uri === 'manifestUri' ? 'MANIFEST_MISSING' : 'REPORT_MISSING');
      if (r[version] !== 'fictional-version-1' || sha(bytes) !== r[hash]) return invalid('OBJECT_HASH_MISMATCH');
      verified.push({ uri: r[uri]!, versionId: r[version]!, sha256: r[hash]!, size: bytes.length });
    }
    let report;
    try { report = JSON.parse(this.objects.get(r.reportUri!)!.toString()); if (report.compilerExitCode !== r.compilerExitCode) return invalid('COMPILATION_REPORT_MISMATCH'); } catch { return invalid('MALFORMED_COMPILATION_REPORT'); }
    if (report.build?.conversionPassed !== true || report.build?.validationPassed !== true || report.build?.toolVersion !== r.toolVersions.chtConf) return invalid('BUILD_EVIDENCE_REQUIRED');
    if (!Array.isArray(report.files) || report.files.length !== this.files.size || new Set(report.files.map((f: {path: string}) => f.path)).size !== this.files.size || !report.files.some((f: {path: string}) => f.path.endsWith('.xml'))) return invalid('BUILD_FILE_COVERAGE_MISMATCH');
    for (const f of report.files) { const bytes = this.files.get(f.path); if (!bytes || sha(bytes) !== f.sha256 || bytes.length !== f.size) return invalid('BUILD_FILE_HASH_MISMATCH'); }

    let manifest;
    try { manifest = JSON.parse(this.objects.get(r.manifestUri!)!.toString()); } catch { return invalid('MALFORMED_MANIFEST'); }
    if (manifest.manifestVersion !== 1 || !manifest.template || manifest.template.hash !== this.templateHash()) return invalid('MANIFEST_METADATA_MISMATCH');
    if (manifest.snapshotHash !== job.logicModelHash || manifest.snapshotHash !== model.snapshotHash || manifest.inputHash !== r.inputHash ||
      manifest.inputHash !== fixtureBareInputHash(model.content) || manifest.schemaVersion !== model.schemaVersion || manifest.compilerVersion !== r.toolVersions.compiler) return invalid('MANIFEST_INPUT_MISMATCH');
    if (!Array.isArray(manifest.files) || manifest.files.length !== [...this.files.keys()].filter(p => !p.endsWith('.xml')).length || new Set(manifest.files.map((f: {path: string}) => f.path)).size !== manifest.files.length) return invalid('FILE_COVERAGE_MISMATCH');
    for (const f of manifest.files) {
      const bytes = this.files.get(f.path);
      if (!bytes || sha(bytes) !== f.sha256 || bytes.length !== f.size) return invalid('FILE_HASH_MISMATCH');
    }
    if (manifest.artifactHash !== fixtureFileListHash(manifest.files.filter((f: {path: string}) => /\.(xlsx|properties\.json)$/.test(f.path)))) return invalid('GENERATED_FILES_HASH_MISMATCH');
    const artifact: VerifiedCompilationArtifact = { verificationId: 'fictional-artifact-check', verifierId: 'fictional-artifact-adapter', verifierVersion: 'fixture-v1',
      jobId: job.jobId, attempt: r.attempt, executionRecordVersion: r.recordVersion, snapshotHash: manifest.snapshotHash, inputHash: manifest.inputHash,
      generatedFilesHash: manifest.artifactHash, manifestVersion: manifest.manifestVersion, templateHash: manifest.template.hash, build: report.build, packagedObject: verified[0], manifest: verified[1], report: verified[2], compilerVersion: manifest.compilerVersion,
      schemaVersion: manifest.schemaVersion, toolVersions: r.toolVersions, stage: 'CHT_CONVERTED', files: report.files };
    return { status: 'VERIFIED' as const, artifact };
  }
}
export async function compilationResultFixture(options: Partial<InMemoryOptions> = {}) {
  const source = new FictionalExecutions();
  const f = await compilationFixture({ ...options, compilationExecutionIsCurrent: Object.hasOwn(options, 'compilationExecutionIsCurrent') ? options.compilationExecutionIsCurrent : (e => source.isCurrent(e)) });
  const started = await f.compile.start(f.command, 'backend'); assert.equal(started.status, 'INTENT_RECORDED');
  const job = started.job!, model = await f.db.getSnapshot({ kind: 'LOGIC_MODEL', requestId: job.requestId, revision: job.logicModelRevision, requestPreview: job.requestPreview });
  if (model?.kind !== 'LOGIC_MODEL') throw Error('fixture');
  const artifacts = new FictionalArtifacts(); source.current = artifacts.make(job, model);
  const runner = Object.freeze({ session: 'fictional-verified-r7' }), wrong = Object.freeze({ session: 'fictional-verified-wrong-role' });
  const db: CompilationResultStore = { ...wrapCompilationStore(f.db, {}), getCompilationResult: (id, job) => f.db.getCompilationResult(id, job),
    apply: (c, p) => f.db.apply(c, p === runner ? 'compiler' : p === wrong ? 'po' : null) };
  const deps: CompilationResultDependencies = { store: db, executions: source, artifacts,
    resolveActor: p => p === runner ? { id: 'fictional-compiler', roles: ['COMPILER'] } : p === wrong ? { id: 'fictional-po', roles: ['PO'] } : null,
    canAccessRequest: (p, id) => id === job.requestId && (p === runner || p === wrong), authorizeRunner: actor => actor.id === 'fictional-compiler' };
  const command: CompilationResultCommand = { requestId: job.requestId, jobId: job.jobId, eventId: 'fictional-compiled-result', expectedVersion: job.workflowVersion,
    attempt: source.current.attempt, executionRecordVersion: source.current.recordVersion };
  return { ...f, db: f.db, resultStore: db, deps, source, artifacts, runner, wrong, commandResult: command, job, model, results: new CompilationResultService(deps) };
}
