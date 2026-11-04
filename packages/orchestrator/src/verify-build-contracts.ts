/**
 * VERIFY_BUILD job intent + outbox. Mirrors the COMPILE_LOGIC handoff
 * (compilation-contracts.ts) but binds the EXACT accepted compiled artifact a
 * verification run must test: the compilation job id plus its packageHash,
 * manifestHash and compileArtifactHash (which live only in the accepted
 * CompilationResultRecord, not in workflow state). R2's internal hashes stay
 * raw 64-hex; R7's `sha256:`-prefixed wire form is reconciled only in the
 * outgoing JobPayload projection (see toVerifyBuildPayload).
 */
import { createHash } from 'node:crypto';
import { canonicalizeJson } from './snapshots.ts';
import type { RevisionIdentity } from './routing.ts';
import { checkerId, checkerSame, checkerVersionNumber } from './checker-contracts.ts';
import { R7_WIRE_CONTRACT_VERSION, toR7Hash } from './r7-wire.ts';

const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

export interface VerifyBuildJobIntent {
  jobId: string;
  jobType: 'VERIFY_BUILD';
  requestId: string;
  revision: number;
  requestPreview: RevisionIdentity;
  logicModelRevision: number;
  logicModelHash: string;
  /** The approved clinical decision this build was compiled under. */
  clinicalApprovalId: string;
  /** The accepted COMPILE_LOGIC job that produced the artifact under test. */
  compileJobId: string;
  /** Packaged project.tgz byte digest (R7 "packageHash" == R2 artifactHash). */
  packageHash: string;
  /** S3 location + version of the packaged object, from the accepted result. */
  packageUri: string;
  packageVersionId: string;
  /** Manifest digest over every converted file, from the accepted result. */
  manifestHash: string;
  /** R5 generated-files digest (XLSX/properties), from the accepted result. */
  compileArtifactHash: string;
  /** Immutable snapshot-envelope object the build was derived from. The REAL
   * S3 URI (s3://<artifact-bucket>/snapshots/<logicModelHash>.json), sourced
   * from the compilation job's verified logic-model reference — never fabricated. */
  snapshotUri: string;
  checkerReportId: string;
  /** SHA-256 (raw hex) of the canonical R4 checker report JSON R7 records as
   * checkReportHash. Sourced from the accepted AcceptedCheckerResult.report in
   * the handoff service; NOT compileArtifactHash or checkerReportId. */
  checkReportHash: string;
  sourceWorkflowVersion: number;
  workflowVersion: number;
  idempotencyKey: string;
  handoffEventId: string;
  createdBy: string;
  createdAt: string;
  status: 'PENDING';
}

export interface VerifyBuildOutbox {
  pk: string;
  sk: 'OUTBOX';
  jobId: string;
  jobType: 'VERIFY_BUILD';
  requestId: string;
  idempotencyKey: string;
  createdAt: string;
  status: 'PENDING';
  /** The exact validated R7 wire payload R7's Pipe forwards from the outbox. */
  payload: Record<string, unknown>;
}

type VerifyBuildIntentInput = Omit<VerifyBuildJobIntent, 'jobId' | 'idempotencyKey' | 'jobType' | 'workflowVersion' | 'status'>;

/** jobId/idempotencyKey bind the exact artifact (compile job + package + manifest).
 * checkReportHash and snapshotUri are evidence about that same artifact, not part
 * of the identity digest, so adding them keeps jobId/idempotency stable. */
export function createVerifyBuildIntent(input: VerifyBuildIntentInput): VerifyBuildJobIntent {
  const digest = createHash('sha256').update(canonicalizeJson({
    namespace: 'verify-build-v1', request: input.requestPreview,
    logic: { logicRevision: input.logicModelRevision, logicHash: input.logicModelHash },
    compileJobId: input.compileJobId, packageHash: input.packageHash, manifestHash: input.manifestHash,
  })).digest('hex');
  return {
    ...input, jobId: `verify-${digest}`, idempotencyKey: `verify-build-v1:${digest}`,
    jobType: 'VERIFY_BUILD', workflowVersion: input.sourceWorkflowVersion + 1, status: 'PENDING',
  };
}

export function verifyBuildOutbox(job: VerifyBuildJobIntent): VerifyBuildOutbox {
  return { pk: `JOB#${job.jobId}`, sk: 'OUTBOX', jobId: job.jobId, jobType: job.jobType,
    requestId: job.requestId, idempotencyKey: job.idempotencyKey, createdAt: job.createdAt, status: 'PENDING',
    payload: toVerifyBuildPayload(job) };
}

/** Reconstruct the intent from its inputs and confirm no field was tampered with. */
export function validVerifyBuildIntent(job: VerifyBuildJobIntent): boolean {
  try {
    const fields = ['jobId', 'jobType', 'requestId', 'revision', 'requestPreview', 'logicModelRevision', 'logicModelHash',
      'clinicalApprovalId', 'compileJobId', 'packageHash', 'packageUri', 'packageVersionId', 'manifestHash', 'compileArtifactHash',
      'snapshotUri', 'checkerReportId', 'checkReportHash', 'sourceWorkflowVersion', 'workflowVersion', 'idempotencyKey', 'handoffEventId', 'createdBy', 'createdAt', 'status'];
    if (Object.keys(job).length !== fields.length || Object.keys(job).some(k => !fields.includes(k))) return false;
    const { jobId, jobType, workflowVersion, status, idempotencyKey, ...input } = job;
    return checkerSame(job, createVerifyBuildIntent(input)) && jobType === 'VERIFY_BUILD' && status === 'PENDING' &&
      [jobId, input.requestId, input.clinicalApprovalId, input.compileJobId, input.checkerReportId, input.handoffEventId, input.createdBy].every(checkerId) &&
      checkerVersionNumber(input.sourceWorkflowVersion) && checkerVersionNumber(workflowVersion) && checkerVersionNumber(input.revision) &&
      checkerVersionNumber(input.logicModelRevision) && hash(input.logicModelHash) && hash(input.packageHash) && hash(input.manifestHash) &&
      hash(input.compileArtifactHash) && hash(input.checkReportHash) && checkerId(input.packageVersionId) && typeof input.packageUri === 'string' && !!input.packageUri &&
      typeof input.snapshotUri === 'string' && !!input.snapshotUri && checkerVersionNumber(input.requestPreview.revision) &&
      input.requestPreview.requestId === input.requestId && hash(input.requestPreview.snapshotHash) &&
      typeof input.createdAt === 'string' && new Date(input.createdAt).toISOString() === input.createdAt;
  } catch { return false; }
}

/** @deprecated use R7_WIRE_CONTRACT_VERSION from r7-wire.ts. Re-exported for callers. */
export { R7_WIRE_CONTRACT_VERSION as R7_CONTRACT_VERSION, toR7Hash } from './r7-wire.ts';

/**
 * Project the internal intent to R7's VerifyBuildPayload (packages/schema
 * handoffs.ts). This is the ONLY place R2's raw-hex hashes are converted to
 * R7's `sha256:` wire form. Shape validated against R7's published schema in
 * the integration boundary (see r7-handoff-contract.ts).
 *
 * checkReportHash is the digest of the canonical R4 checker report JSON (carried
 * on the intent as job.checkReportHash) — NOT compileArtifactHash. snapshotUri
 * is the real immutable S3 snapshot object URI.
 */
export function toVerifyBuildPayload(job: VerifyBuildJobIntent): Record<string, unknown> {
  return {
    contractVersion: R7_WIRE_CONTRACT_VERSION,
    jobId: job.jobId,
    jobType: 'VERIFY_BUILD',
    requestId: job.requestId,
    revision: job.revision,
    logicModelHash: toR7Hash(job.logicModelHash),
    snapshotUri: job.snapshotUri,
    checkReportHash: toR7Hash(job.checkReportHash),
    clinicalApprovalId: job.clinicalApprovalId,
    compileJobId: job.compileJobId,
    packageUri: job.packageUri,
    packageHash: toR7Hash(job.packageHash),
    compileArtifactHash: toR7Hash(job.compileArtifactHash),
    manifestHash: toR7Hash(job.manifestHash),
    createdBy: job.createdBy,
    createdAt: job.createdAt,
    // goldenCasesUri/goldenCasesHash deliberately OMITTED: R2 owns no
    // authoritative golden-case object reference. Set both or neither.
  };
}
