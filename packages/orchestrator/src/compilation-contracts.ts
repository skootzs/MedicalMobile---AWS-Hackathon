import { createHash } from 'node:crypto';
import { canonicalizeJson, HASH_POLICY_VERSION } from './snapshots.ts';
import type { LogicModelSnapshot } from './snapshots.ts';
import type { RevisionIdentity } from './routing.ts';
import type { LogicIdentity } from './workflow.ts';
import { checkerId, checkerSame, checkerVersionNumber } from './checker-contracts.ts';
import { R7_CONTRACT_VERSION, toR7Hash } from './verify-build-contracts.ts';

/** Provisional R2/R5/R7 transport contract. No shared handoff contract exists locally. */
export const LOGIC_OBJECT_FORMAT = 'r2-snapshot-envelope-without-hash-v1' as const;
export interface VerifiedLogicModelReference {
  requestPreview: RevisionIdentity;
  logic: LogicIdentity;
  uri: string;
  versionId: string;
  verificationId: string;
  representation: typeof LOGIC_OBJECT_FORMAT;
  hashPolicyVersion: typeof HASH_POLICY_VERSION;
  byteSha256: string;
  byteLength: number;
}
/** Trusted server adapter: upload first, verify exact immutable bytes/version, then return.
 * No browser references or client-provided verification flags may implement this boundary. */
export interface LogicModelReferenceProvider {
  getVerifiedReference(snapshot: LogicModelSnapshot): Promise<VerifiedLogicModelReference | null>;
}
/** Same hash coverage as snapshots.ts: UTF-8 JCS envelope EXCLUDING snapshotHash.
 * R7 must verify these object bytes, then extract content for R5 /in/logic.json. */
export function logicObjectBytes(snapshot: LogicModelSnapshot): Buffer {
  const { snapshotHash, ...envelope } = snapshot;
  const bytes = Buffer.from(canonicalizeJson(envelope), 'utf8');
  if (snapshot.kind !== 'LOGIC_MODEL' || snapshot.hashPolicyVersion !== HASH_POLICY_VERSION ||
      createHash('sha256').update(bytes).digest('hex') !== snapshotHash) throw Error('Logic snapshot integrity failure.');
  return bytes;
}
export function referenceMatches(ref: unknown, snapshot: LogicModelSnapshot): ref is VerifiedLogicModelReference {
  try {
    const r = JSON.parse(canonicalizeJson(ref)) as VerifiedLogicModelReference;
    const fields = ['requestPreview', 'logic', 'uri', 'versionId', 'verificationId', 'representation', 'hashPolicyVersion', 'byteSha256', 'byteLength'];
    return !!r && Object.keys(r).length === fields.length && Object.keys(r).every(k => fields.includes(k)) &&
      checkerSame(r.requestPreview, snapshot.requestPreview) && checkerSame(r.logic, { logicRevision: snapshot.revision, logicHash: snapshot.snapshotHash }) &&
      r.representation === LOGIC_OBJECT_FORMAT && r.hashPolicyVersion === HASH_POLICY_VERSION && r.byteSha256 === snapshot.snapshotHash &&
      r.byteLength === logicObjectBytes(snapshot).byteLength && checkerId(r.versionId) && checkerId(r.verificationId) &&
      typeof r.uri === 'string' && new RegExp(`^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/snapshots/${snapshot.snapshotHash}\\.json$`).test(r.uri);
  } catch { return false; }
}
export interface CompilationJobIntent {
  jobId: string;
  jobType: 'COMPILE_LOGIC';
  mode: 'approved';
  requestId: string;
  /** Request revision, distinct from logicModelRevision and workflow versions. */
  revision: number;
  requestPreview: RevisionIdentity;
  logicModelRevision: number;
  logicModelHash: string;
  logicModelUri: string;
  snapshotReference: VerifiedLogicModelReference;
  /** Existing approved CLINICAL_DECISION eventId, scoped by requestId. */
  clinicalApprovalId: string;
  checkerReportId: string;
  checkerInvocationId: string;
  sourceWorkflowVersion: number;
  workflowVersion: number;
  idempotencyKey: string;
  handoffEventId: string;
  createdBy: string;
  createdAt: string;
  /** Authoritative local initial job status, not workflow approval or delivery status. */
  status: 'PENDING';
  // baselineHash intentionally absent: no authoritative baseline exists locally.
}
export interface CompilationOutbox {
  pk: string;
  sk: 'OUTBOX';
  jobId: string;
  jobType: 'COMPILE_LOGIC';
  requestId: string;
  idempotencyKey: string;
  createdAt: string;
  /** Thin pointer; consumer must load authoritative JOB#jobId / META. */
  status: 'PENDING';
}
export function createCompilationIntent(input: Omit<CompilationJobIntent, 'jobId' | 'idempotencyKey' | 'jobType' | 'mode' | 'workflowVersion' | 'status'>): CompilationJobIntent {
  const digest = createHash('sha256').update(canonicalizeJson({ namespace: 'approved-compilation-v1', request: input.requestPreview,
    logic: { logicRevision: input.logicModelRevision, logicHash: input.logicModelHash }, clinicalApprovalId: input.clinicalApprovalId })).digest('hex');
  return { ...input, jobId: `compile-${digest}`, idempotencyKey: `approved-compilation-v1:${digest}`,
    jobType: 'COMPILE_LOGIC', mode: 'approved', workflowVersion: input.sourceWorkflowVersion + 1, status: 'PENDING' };
}
export function compilationOutbox(job: CompilationJobIntent): CompilationOutbox {
  return { pk: `JOB#${job.jobId}`, sk: 'OUTBOX', jobId: job.jobId, jobType: job.jobType,
    requestId: job.requestId, idempotencyKey: job.idempotencyKey, createdAt: job.createdAt, status: 'PENDING' };
}
export function validCompilationIntent(job: CompilationJobIntent, snapshot: LogicModelSnapshot): boolean {
  try {
    const fields = ['jobId', 'jobType', 'mode', 'requestId', 'revision', 'requestPreview', 'logicModelRevision', 'logicModelHash', 'logicModelUri', 'snapshotReference', 'clinicalApprovalId', 'checkerReportId', 'checkerInvocationId', 'sourceWorkflowVersion', 'workflowVersion', 'idempotencyKey', 'handoffEventId', 'createdBy', 'createdAt', 'status'];
    if (Object.keys(job).length !== fields.length || Object.keys(job).some(k => !fields.includes(k))) return false;
    const { jobId, jobType, mode, workflowVersion, status, idempotencyKey, ...input } = job;
    return checkerSame(job, createCompilationIntent(input)) && jobType === 'COMPILE_LOGIC' && mode === 'approved' && status === 'PENDING' &&
      [jobId, input.requestId, input.clinicalApprovalId, input.checkerReportId, input.checkerInvocationId, input.handoffEventId, input.createdBy].every(checkerId) &&
      checkerVersionNumber(input.sourceWorkflowVersion) && checkerVersionNumber(workflowVersion) && checkerVersionNumber(input.revision) &&
      input.requestId === snapshot.requestId && input.revision === snapshot.requestPreview.revision && checkerSame(input.requestPreview, snapshot.requestPreview) &&
      input.logicModelRevision === snapshot.revision && input.logicModelHash === snapshot.snapshotHash && input.logicModelUri === input.snapshotReference.uri &&
      referenceMatches(input.snapshotReference, snapshot) && typeof input.createdAt === 'string' && new Date(input.createdAt).toISOString() === input.createdAt;
  } catch { return false; }
}

/** Project the internal intent to R7's COMPILE_LOGIC payload. checkReportHash is the raw checker-report digest. */
export function toCompilationPayload(job: CompilationJobIntent, checkReportHash: string): Record<string, unknown> {
  return {
    contractVersion: R7_CONTRACT_VERSION,
    jobId: job.jobId,
    jobType: 'COMPILE_LOGIC',
    mode: job.mode,
    requestId: job.requestId,
    revision: job.revision,
    logicModelHash: toR7Hash(job.logicModelHash),
    snapshotUri: job.logicModelUri,
    checkReportHash: toR7Hash(checkReportHash),
    clinicalApprovalId: job.clinicalApprovalId,
    createdBy: job.createdBy,
    createdAt: job.createdAt,
  };
}
