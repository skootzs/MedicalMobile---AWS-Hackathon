/**
 * VERIFY_BUILD result contracts. Mirrors compilation-result-contracts.ts but
 * for R6 verification: the authoritative evidence is R6's VerificationReport
 * (fetched from immutable storage, byte-verified and schema-validated by the
 * ingestion service), plus R7's job attempt record (version/attempt) so a stale
 * attempt cannot advance the workflow.
 *
 * R2 records what it accepted; it never computes verification outcomes.
 */
import { canonicalizeJson } from './snapshots.ts';
import type { RevisionIdentity } from './routing.ts';
import { checkerId, checkerSame, checkerVersionNumber } from './checker-contracts.ts';
import type { VerifyBuildJobIntent } from './verify-build-contracts.ts';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const closed = (v: object, keys: string[]) => Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const uri = (v: unknown): v is string => typeof v === 'string' && /^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/[^\s?#]+$/.test(v);

/**
 * R7's VERIFY_BUILD JOB/META attempt, normalized for R2's current-attempt check
 * (the same role CompilationExecution plays for compile). Minimal by design:
 * the real evidence is the report, not a rich R7 record.
 */
export interface VerificationExecution {
  requestId: string;
  jobId: string;
  jobType: 'VERIFY_BUILD';
  attempt: number;
  recordVersion: string;
  runnerActorId: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'EXHAUSTED';
  requestPreview: RevisionIdentity;
  logicModelRevision: number;
  logicModelHash: string;
  clinicalApprovalId: string;
  compileJobId: string;
  jobWorkflowVersion: number;
  /** Immutable report object produced by the run (null until SUCCEEDED/FAILED with a report). */
  reportUri: string | null;
  reportHash: string | null;
  reportVersionId: string | null;
  /** Echoed gate fields R7 copies off the report; R2 re-derives from the report itself. */
  verificationPassed: boolean | null;
  coverageComplete: boolean | null;
  reportVersion: string | null;
  startedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface VerificationExecutionSource {
  getCurrent(requestId: string, jobId: string): Promise<VerificationExecution | null>;
}

/** What R2 persists after accepting a VERIFY_BUILD result. */
export interface VerificationResultRecord {
  requestId: string;
  jobId: string;
  eventId: string;
  requestPreview: RevisionIdentity;
  logicModelRevision: number;
  logicModelHash: string;
  clinicalApprovalId: string;
  compileJobId: string;
  acceptedWorkflowVersion: number;
  outcome: 'VERIFIED' | 'FAILED';
  /** Authoritative verification report identity R2 accepted. */
  reportUri: string;
  reportHash: string;
  reportVersionId: string;
  reportVersion: string;
  /** Gate values R2 read FROM the validated report (not from R7's echo). */
  passed: boolean;
  coverageComplete: boolean;
  /** Build hashes the report attested to, re-checked against R2's artifact. */
  testedDirHash: string;
  compileArtifactHash: string;
  execution: VerificationExecution;
}

const instant = (v: unknown): v is string => { try { return typeof v === 'string' && new Date(v).toISOString() === v; } catch { return false; } };

export function parseVerificationExecution(raw: unknown): VerificationExecution | null {
  try {
    const r = JSON.parse(canonicalizeJson(raw));
    const fields = ['requestId', 'jobId', 'jobType', 'attempt', 'recordVersion', 'runnerActorId', 'status', 'requestPreview',
      'logicModelRevision', 'logicModelHash', 'clinicalApprovalId', 'compileJobId', 'jobWorkflowVersion',
      'reportUri', 'reportHash', 'reportVersionId', 'verificationPassed', 'coverageComplete', 'reportVersion',
      'startedAt', 'finishedAt', 'errorCode', 'errorMessage'];
    if (!object(r) || !closed(r, fields) || ![r.requestId, r.jobId, r.recordVersion, r.runnerActorId, r.clinicalApprovalId, r.compileJobId].every(checkerId) ||
      ![r.attempt, r.logicModelRevision, r.jobWorkflowVersion].every(checkerVersionNumber) || !digest(r.logicModelHash) || r.jobType !== 'VERIFY_BUILD' ||
      !['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'EXHAUSTED'].includes(r.status as string) ||
      !object(r.requestPreview) || !closed(r.requestPreview, ['requestId', 'revision', 'snapshotHash']) ||
      r.requestPreview.requestId !== r.requestId || !checkerVersionNumber(r.requestPreview.revision) || !digest(r.requestPreview.snapshotHash) ||
      !instant(r.startedAt) || !(r.finishedAt === null || instant(r.finishedAt))) return null;
    if (r.reportUri !== null && !uri(r.reportUri)) return null;
    if (r.reportHash !== null && !digest(r.reportHash)) return null;
    if (r.reportVersionId !== null && !checkerId(r.reportVersionId)) return null;
    if (r.reportVersion !== null && (typeof r.reportVersion !== 'string' || !r.reportVersion.trim())) return null;
    for (const k of ['verificationPassed', 'coverageComplete']) if (r[k] !== null && typeof r[k] !== 'boolean') return null;
    for (const k of ['errorCode']) if (r[k] !== null && !checkerId(r[k])) return null;
    if (r.errorMessage !== null && (typeof r.errorMessage !== 'string' || !r.errorMessage.trim())) return null;
    return r as unknown as VerificationExecution;
  } catch { return null; }
}

export function verificationExecutionMatchesJob(r: VerificationExecution, job: VerifyBuildJobIntent): boolean {
  return r.requestId === job.requestId && r.jobId === job.jobId && r.jobType === 'VERIFY_BUILD' &&
    checkerSame(r.requestPreview, job.requestPreview) && r.logicModelRevision === job.logicModelRevision &&
    r.logicModelHash === job.logicModelHash && r.clinicalApprovalId === job.clinicalApprovalId &&
    r.compileJobId === job.compileJobId && r.jobWorkflowVersion === job.workflowVersion;
}

export function verificationResultMatchesJob(result: VerificationResultRecord, job: VerifyBuildJobIntent): boolean {
  try {
    canonicalizeJson(result);
    return closed(result, ['requestId', 'jobId', 'eventId', 'requestPreview', 'logicModelRevision', 'logicModelHash', 'clinicalApprovalId',
      'compileJobId', 'acceptedWorkflowVersion', 'outcome', 'reportUri', 'reportHash', 'reportVersionId', 'reportVersion',
      'passed', 'coverageComplete', 'testedDirHash', 'compileArtifactHash', 'execution']) &&
      result.requestId === job.requestId && result.jobId === job.jobId && checkerId(result.eventId) &&
      checkerSame(result.requestPreview, job.requestPreview) && result.logicModelRevision === job.logicModelRevision &&
      result.logicModelHash === job.logicModelHash && result.clinicalApprovalId === job.clinicalApprovalId &&
      result.compileJobId === job.compileJobId && result.acceptedWorkflowVersion === job.workflowVersion + 1 &&
      !!parseVerificationExecution(result.execution) && verificationExecutionMatchesJob(result.execution, job) &&
      uri(result.reportUri) && digest(result.reportHash) && checkerId(result.reportVersionId) &&
      typeof result.reportVersion === 'string' && !!result.reportVersion && typeof result.passed === 'boolean' &&
      typeof result.coverageComplete === 'boolean' && digest(result.testedDirHash) && digest(result.compileArtifactHash) &&
      result.compileArtifactHash === job.compileArtifactHash &&
      (result.outcome === 'VERIFIED'
        ? result.passed === true && result.coverageComplete === true && result.execution.status === 'SUCCEEDED'
        : result.outcome === 'FAILED');
  } catch { return false; }
}
