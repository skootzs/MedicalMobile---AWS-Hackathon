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
import { R7_CONTRACT_VERSION } from './r7-handoff-contract.ts';

export { R7_CONTRACT_VERSION };

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
  /** Immutable snapshot-envelope object the build was derived from. */
  snapshotUri: string;
  checkerReportId: string;
  goldenCases?: { uri: string; sha256: string };
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
}

type VerifyBuildIntentInput = Omit<VerifyBuildJobIntent, 'jobId' | 'idempotencyKey' | 'jobType' | 'workflowVersion' | 'status'>;

/** jobId/idempotencyKey bind the exact artifact (compile job + package + manifest). */
export function createVerifyBuildIntent(input: VerifyBuildIntentInput): VerifyBuildJobIntent {
  const digest = createHash('sha256').update(canonicalizeJson({
    namespace: 'verify-build-v1', request: input.requestPreview,
    logic: { logicRevision: input.logicModelRevision, logicHash: input.logicModelHash },
    compileJobId: input.compileJobId, packageHash: input.packageHash, manifestHash: input.manifestHash,
    ...(input.goldenCases ? { goldenCases: input.goldenCases } : {}),
  })).digest('hex');
  return {
    ...input, jobId: `verify-${digest}`, idempotencyKey: `verify-build-v1:${digest}`,
    jobType: 'VERIFY_BUILD', workflowVersion: input.sourceWorkflowVersion + 1, status: 'PENDING',
  };
}

export function verifyBuildOutbox(job: VerifyBuildJobIntent): VerifyBuildOutbox {
  return { pk: `JOB#${job.jobId}`, sk: 'OUTBOX', jobId: job.jobId, jobType: job.jobType,
    requestId: job.requestId, idempotencyKey: job.idempotencyKey, createdAt: job.createdAt, status: 'PENDING' };
}

/** Reconstruct the intent from its inputs and confirm no field was tampered with. */
export function validVerifyBuildIntent(job: VerifyBuildJobIntent): boolean {
  try {
    const fields = ['jobId', 'jobType', 'requestId', 'revision', 'requestPreview', 'logicModelRevision', 'logicModelHash',
      'clinicalApprovalId', 'compileJobId', 'packageHash', 'packageUri', 'packageVersionId', 'manifestHash', 'compileArtifactHash',
      'snapshotUri', 'checkerReportId', 'sourceWorkflowVersion', 'workflowVersion', 'idempotencyKey', 'handoffEventId', 'createdBy', 'createdAt', 'status'];
    if (job.goldenCases) fields.push('goldenCases');
    if (Object.keys(job).length !== fields.length || Object.keys(job).some(k => !fields.includes(k))) return false;
    const { jobId, jobType, workflowVersion, status, idempotencyKey, ...input } = job;
    return checkerSame(job, createVerifyBuildIntent(input)) && jobType === 'VERIFY_BUILD' && status === 'PENDING' &&
      [jobId, input.requestId, input.clinicalApprovalId, input.compileJobId, input.checkerReportId, input.handoffEventId, input.createdBy].every(checkerId) &&
      checkerVersionNumber(input.sourceWorkflowVersion) && checkerVersionNumber(workflowVersion) && checkerVersionNumber(input.revision) &&
      checkerVersionNumber(input.logicModelRevision) && hash(input.logicModelHash) && hash(input.packageHash) && hash(input.manifestHash) &&
      hash(input.compileArtifactHash) && (!input.goldenCases ||
        (Object.keys(input.goldenCases).length === 2 && /^s3:\/\/[^/]+\/.+/.test(input.goldenCases.uri) && hash(input.goldenCases.sha256))) && checkerId(input.packageVersionId) && typeof input.packageUri === 'string' && !!input.packageUri &&
      typeof input.snapshotUri === 'string' && !!input.snapshotUri && checkerVersionNumber(input.requestPreview.revision) &&
      input.requestPreview.requestId === input.requestId && hash(input.requestPreview.snapshotHash) &&
      typeof input.createdAt === 'string' && new Date(input.createdAt).toISOString() === input.createdAt;
  } catch { return false; }
}

/** R2 raw hex -> R7's prefixed hash form, reconciled ONLY at this boundary. */
export const toR7Hash = (rawHex: string): string => `sha256:${rawHex}`;

/**
 * Project the internal intent to R7's VerifyBuildPayload (packages/schema
 * handoffs.ts). This is the ONLY place R2's raw-hex logicModelHash is converted
 * to R7's `sha256:` prefix. Shape validated against R7's published schema in
 * the integration boundary (see r7-handoff-contract.ts).
 */
export function toVerifyBuildPayload(job: VerifyBuildJobIntent, checkReportHash: string): Record<string, unknown> {
  return {
    contractVersion: R7_CONTRACT_VERSION,
    jobId: job.jobId,
    jobType: 'VERIFY_BUILD',
    requestId: job.requestId,
    revision: job.revision,
    logicModelHash: toR7Hash(job.logicModelHash),
    snapshotUri: job.snapshotUri,
    checkReportHash: toR7Hash(checkReportHash),
    clinicalApprovalId: job.clinicalApprovalId,
    compileJobId: job.compileJobId,
    packageUri: job.packageUri,
    packageHash: toR7Hash(job.packageHash),
    compileArtifactHash: toR7Hash(job.compileArtifactHash),
    manifestHash: toR7Hash(job.manifestHash),
    ...(job.goldenCases ? { goldenCasesUri: job.goldenCases.uri, goldenCasesHash: toR7Hash(job.goldenCases.sha256) } : {}),
    createdBy: job.createdBy,
    createdAt: job.createdAt,
  };
}
