import { canonicalizeJson } from './snapshots.ts';
import type { JsonValue, LogicModelSnapshot } from './snapshots.ts';
import { checkerId, checkerSame, checkerVersionNumber } from './checker-contracts.ts';
import type { CompilationJobIntent } from './compilation-contracts.ts';
import type { RevisionIdentity } from './routing.ts';

/** Provisional R2 normalized view of R7 JOB/META, not an SQS payload or runner implementation. */
export interface CompilationExecution {
  requestId: string; jobId: string; jobType: 'COMPILE_LOGIC'; mode: 'approved';
  attempt: number; recordVersion: string; runnerActorId: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'EXHAUSTED';
  requestPreview: RevisionIdentity; logicModelRevision: number; logicModelHash: string;
  clinicalApprovalId: string; jobWorkflowVersion: number;
  inputHash: string | null;
  /** R5 generated XLSX/properties digest; future R6 compileArtifactHash. */
  compileArtifactHash: string | null;
  /** NORMALIZED R2 alias for R7 packageHash, NOT an unqualified wire artifactHash.
   * R7 packaged-object BYTE digest. Never R5's generated-file artifactHash. */
  artifactHash: string | null; artifactUri: string | null; artifactVersionId: string | null;
  manifestUri: string | null; manifestHash: string | null; manifestVersionId: string | null;
  reportUri: string | null; reportHash: string | null; reportVersionId: string | null;
  toolVersions: Readonly<Record<string, string>>;
  startedAt: string; finishedAt: string | null;
  compilerExitCode: 0 | 1 | 2 | null;
  chtConfStatus: 'NOT_RUN' | 'PASSED' | 'FAILED';
  failureKind: 'COMPILER_REJECTED' | 'COMPILER_USAGE_OR_FILE_ERROR' | 'CHT_CONVERSION_FAILED' | 'CHT_VALIDATION_FAILED' | 'RUNNER_FAILED' | 'TIMED_OUT' | 'RETRIES_EXHAUSTED' | null;
  errorCode: string | null; errorMessage: string | null; logUri: string | null;
  diagnostics: JsonValue;
}
export interface CompilationExecutionSource {
  /** Strongly current read of the authoritative job/attempt; not a notification cache. */
  getCurrent(requestId: string, jobId: string): Promise<CompilationExecution | null>;
}
export interface ObjectDigest { uri: string; versionId: string; sha256: string; size: number }
export interface VerifiedCompilationArtifact {
  verificationId: string; verifierId: string; verifierVersion: string;
  jobId: string; attempt: number; executionRecordVersion: string;
  /** R5 manifest snapshotHash echoes the approved R2 hash; it is not an independent content check. */
  snapshotHash: string; inputHash: string;
  /** R5 artifactHash: sorted path<TAB>sha256<NEWLINE> for XLSX/properties, not XML. */
  generatedFilesHash: string;
  manifestVersion: 1;
  /** R5 template.hash uses file-list hashing, excluding .gitkeep/.DS_Store; not a baseline. */
  templateHash: string;
  build: { conversionPassed: boolean; validationPassed: boolean; toolVersion: string };
  packagedObject: ObjectDigest; manifest: ObjectDigest; report: ObjectDigest;
  compilerVersion: string; schemaVersion: string; toolVersions: Readonly<Record<string, string>>;
  stage: 'R5_GENERATED' | 'CHT_CONVERTED';
  files: readonly { path: string; sha256: string; size: number }[];
}
export type ArtifactVerification = { status: 'VERIFIED'; artifact: VerifiedCompilationArtifact }
  | { status: 'INVALID' | 'UNAVAILABLE'; reason: string };
/** Trusted server boundary MUST fetch pinned bytes, check digests, validate manifest/file
 * coverage (including archive membership/path safety), report consistency, manifestVersion/template.hash and bare-content R5 input mapping.
 * Cross-check R5 hash algorithms against published code/shared fixtures before relying
 * on local recomputation. An echoed snapshotHash alone proves nothing about input bytes.
 * No permissive production default or client trust flag. */
export interface CompilationArtifactVerifier {
  verify(input: { job: CompilationJobIntent; execution: CompilationExecution; model: LogicModelSnapshot }): Promise<ArtifactVerification | null>;
}
export interface CompilationResultRecord {
  requestId: string; jobId: string; eventId: string; requestPreview: RevisionIdentity;
  logicModelRevision: number; logicModelHash: string; clinicalApprovalId: string;
  checkerReportId: string; checkerInvocationId: string; acceptedWorkflowVersion: number;
  outcome: 'COMPILED' | 'FAILED'; execution: CompilationExecution; artifact: VerifiedCompilationArtifact | null;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const closed = (v: object, keys: string[]) => Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
const uri = (v: unknown): v is string => typeof v === 'string' && /^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/[^\s?#]+$/.test(v);
const instant = (v: unknown): v is string => { try { return typeof v === 'string' && new Date(v).toISOString() === v; } catch { return false; } };
const tools = (v: unknown) => object(v) && Object.keys(v).length > 0 && Object.entries(v).every(([k, value]) => checkerId(k) && checkerId(value));
export function parseCompilationExecution(raw: unknown): CompilationExecution | null {
  try {
    const r = JSON.parse(canonicalizeJson(raw));
    const fields = ['requestId','jobId','jobType','mode','attempt','recordVersion','runnerActorId','status','requestPreview','logicModelRevision','logicModelHash','clinicalApprovalId','jobWorkflowVersion',
      'inputHash','compileArtifactHash','artifactHash','artifactUri','artifactVersionId','manifestUri','manifestHash','manifestVersionId','reportUri','reportHash','reportVersionId','toolVersions','startedAt','finishedAt',
      'compilerExitCode','chtConfStatus','failureKind','errorCode','errorMessage','logUri','diagnostics'];
    if (!object(r) || !closed(r, fields) || ![r.requestId,r.jobId,r.recordVersion,r.runnerActorId,r.clinicalApprovalId].every(checkerId) ||
      ![r.attempt,r.logicModelRevision,r.jobWorkflowVersion].every(checkerVersionNumber) || !digest(r.logicModelHash) || r.jobType !== 'COMPILE_LOGIC' || r.mode !== 'approved' ||
      !['QUEUED','RUNNING','SUCCEEDED','FAILED','TIMED_OUT','EXHAUSTED'].includes(r.status as string) || !object(r.requestPreview) || !closed(r.requestPreview,['requestId','revision','snapshotHash']) ||
      r.requestPreview.requestId !== r.requestId || !checkerVersionNumber(r.requestPreview.revision) || !digest(r.requestPreview.snapshotHash) || !tools(r.toolVersions) || !instant(r.startedAt) ||
      !(r.finishedAt === null || instant(r.finishedAt)) || (r.finishedAt !== null && Date.parse(r.finishedAt as string) < Date.parse(r.startedAt)) ||
      ![null,0,1,2].includes(r.compilerExitCode as never) || !['NOT_RUN','PASSED','FAILED'].includes(r.chtConfStatus as string)) return null;
    for (const k of ['inputHash','compileArtifactHash','artifactHash','manifestHash','reportHash']) if (r[k] !== null && !digest(r[k])) return null;
    for (const k of ['artifactUri','manifestUri','reportUri','logUri']) if (r[k] !== null && !uri(r[k])) return null;
    for (const k of ['artifactVersionId','manifestVersionId','reportVersionId','errorCode']) if (r[k] !== null && !checkerId(r[k])) return null;
    if (r.errorMessage !== null && (typeof r.errorMessage !== 'string' || !r.errorMessage.trim())) return null;
    const failures = ['COMPILER_REJECTED','COMPILER_USAGE_OR_FILE_ERROR','CHT_CONVERSION_FAILED','CHT_VALIDATION_FAILED','RUNNER_FAILED','TIMED_OUT','RETRIES_EXHAUSTED'];
    if (r.failureKind !== null && !failures.includes(r.failureKind as string)) return null;
    if (r.status === 'SUCCEEDED' && (r.compilerExitCode !== 0 || r.failureKind !== null || r.errorCode !== null || r.errorMessage !== null || !r.finishedAt || r.chtConfStatus === 'FAILED')) return null;
    if (['FAILED','TIMED_OUT','EXHAUSTED'].includes(r.status as string) && (!r.finishedAt || !r.failureKind || !r.errorCode || !r.errorMessage)) return null;
    if (r.status === 'TIMED_OUT' && r.failureKind !== 'TIMED_OUT' || r.status === 'EXHAUSTED' && r.failureKind !== 'RETRIES_EXHAUSTED') return null;
    if (r.failureKind === 'COMPILER_REJECTED' && r.compilerExitCode !== 1 || r.failureKind === 'COMPILER_USAGE_OR_FILE_ERROR' && r.compilerExitCode !== 2) return null;
    return r as unknown as CompilationExecution;
  } catch { return null; }
}
export function executionMatchesJob(r: CompilationExecution, job: CompilationJobIntent): boolean {
  return r.requestId === job.requestId && r.jobId === job.jobId && r.jobType === job.jobType && r.mode === job.mode &&
    checkerSame(r.requestPreview, job.requestPreview) && r.logicModelRevision === job.logicModelRevision && r.logicModelHash === job.logicModelHash &&
    r.clinicalApprovalId === job.clinicalApprovalId && r.jobWorkflowVersion === job.workflowVersion;
}
const objectDigest = (v: unknown): v is ObjectDigest => object(v) && closed(v,['uri','versionId','sha256','size']) && uri(v.uri) && checkerId(v.versionId) && digest(v.sha256) && Number.isSafeInteger(v.size) && (v.size as number) > 0;
export function artifactMatches(a: unknown, r: CompilationExecution, job: CompilationJobIntent, model: LogicModelSnapshot): a is VerifiedCompilationArtifact {
  try {
    canonicalizeJson(a);
    if (!object(a) || !closed(a, ['verificationId','verifierId','verifierVersion','jobId','attempt','executionRecordVersion','snapshotHash','inputHash','generatedFilesHash','manifestVersion','templateHash','build','packagedObject','manifest','report','compilerVersion','schemaVersion','toolVersions','stage','files']) ||
      ![a.verificationId,a.verifierId,a.verifierVersion,a.compilerVersion,a.schemaVersion].every(checkerId) || a.jobId !== job.jobId || a.attempt !== r.attempt || a.executionRecordVersion !== r.recordVersion ||
      a.snapshotHash !== job.logicModelHash || a.snapshotHash !== model.snapshotHash || a.inputHash !== r.inputHash || !digest(a.inputHash) || !digest(a.generatedFilesHash) || a.generatedFilesHash !== r.compileArtifactHash ||
      a.manifestVersion !== 1 || !digest(a.templateHash) || !object(a.build) || !closed(a.build,['conversionPassed','validationPassed','toolVersion']) ||
      a.build.conversionPassed !== true || a.build.validationPassed !== true || !checkerId(a.build.toolVersion) || a.build.toolVersion !== r.toolVersions.chtConf ||
      !objectDigest(a.packagedObject) || !objectDigest(a.manifest) || !objectDigest(a.report) || a.packagedObject.uri !== r.artifactUri || a.packagedObject.sha256 !== r.artifactHash || a.packagedObject.versionId !== r.artifactVersionId ||
      a.manifest.uri !== r.manifestUri || a.manifest.sha256 !== r.manifestHash || a.manifest.versionId !== r.manifestVersionId || a.report.uri !== r.reportUri || a.report.sha256 !== r.reportHash || a.report.versionId !== r.reportVersionId ||
      a.schemaVersion !== model.schemaVersion || !tools(a.toolVersions) || !checkerSame(a.toolVersions, r.toolVersions) || a.compilerVersion !== r.toolVersions.compiler ||
      r.chtConfStatus !== 'PASSED' || a.stage !== 'CHT_CONVERTED' || !Array.isArray(a.files) || a.files.length === 0) return false;
    const paths = new Set<string>();
    for (const f of a.files) {
      if (!object(f) || !closed(f,['path','sha256','size']) || typeof f.path !== 'string' || !f.path || f.path.startsWith('/') || f.path.includes('\\') ||
        f.path.split('/').some(p => !p || p === '.' || p === '..') || !digest(f.sha256) || !Number.isSafeInteger(f.size) || (f.size as number) < 0 || paths.has(f.path)) return false;
      paths.add(f.path);
    }
    return true;
  } catch { return false; }
}
export function resultMatchesJob(result: CompilationResultRecord, job: CompilationJobIntent, model: LogicModelSnapshot): boolean {
  try {
    canonicalizeJson(result);
    return closed(result,['requestId','jobId','eventId','requestPreview','logicModelRevision','logicModelHash','clinicalApprovalId','checkerReportId','checkerInvocationId','acceptedWorkflowVersion','outcome','execution','artifact']) &&
      result.requestId === job.requestId && result.jobId === job.jobId && checkerId(result.eventId) && checkerSame(result.requestPreview, job.requestPreview) &&
      result.logicModelRevision === job.logicModelRevision && result.logicModelHash === job.logicModelHash && result.clinicalApprovalId === job.clinicalApprovalId &&
      result.checkerReportId === job.checkerReportId && result.checkerInvocationId === job.checkerInvocationId && result.acceptedWorkflowVersion === job.workflowVersion + 1 &&
      !!parseCompilationExecution(result.execution) && executionMatchesJob(result.execution, job) && (result.outcome === 'COMPILED'
        ? result.execution.status === 'SUCCEEDED' && artifactMatches(result.artifact, result.execution, job, model)
        : result.outcome === 'FAILED' && ['FAILED','TIMED_OUT','EXHAUSTED'].includes(result.execution.status) && result.artifact === null);
  } catch { return false; }
}
