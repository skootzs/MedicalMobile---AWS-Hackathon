/**
 * R7 JOB/META adapter (R2-owned integration boundary).
 *
 * R7's runner writes the `JobResult` fields FLAT onto `JOB#<jobId>/META`
 * (runner/src/store.ts commitResult on the r7-infra branch): `status`,
 * `attempt`, `leaseOwner`, the hash chain, `reportUri`/`reportHash`/
 * `verificationPassed`/`coverageComplete`/`testedDirHash`/`reportVersion`, etc.
 * There is NO nested `execution` object and NO `recordVersion`.
 *
 * R2's ingestion services consume a normalized CompilationExecution /
 * VerificationExecution. This module adapts R7's authoritative flat META record
 * into those shapes WITHOUT weakening R2's validation: every field R2 requires
 * is derived from the authoritative META item (or the job intent), and the
 * attempt is captured so the DynamoDB transaction can condition on the exact
 * R7 attempt+status it read (fail closed on a stale attempt).
 *
 * Because R7 has no `recordVersion`, R2 synthesizes a stable surrogate
 * `r7-attempt-<n>` from the authoritative `attempt`, and the matching condition
 * builders gate on the REAL R7 attributes (`attempt`, `status`). The surrogate
 * is internal to R2 and is consistent between the read and the condition.
 *
 * Hash reconciliation: R7 may send hashes `sha256:`-prefixed on the wire; R2
 * stores/compares raw hex. `rawHex()` strips a `sha256:` prefix at this single
 * boundary so R2's validators see raw 64-hex, exactly as its internal identities.
 */
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient, TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { CompilationExecution, CompilationExecutionSource } from './compilation-result-contracts.ts';
import type { VerificationExecution, VerificationExecutionSource } from './verification-result-contracts.ts';
import type { CompilationJobIntent } from './compilation-contracts.ts';
import type { VerifyBuildJobIntent } from './verify-build-contracts.ts';
import type { CompilationResultStore } from './storage/compilation-results.ts';
import type { VerificationResultStore } from './storage/verification-results.ts';
import type { DynamoStoreOptions } from './storage/dynamodb.ts';

type ConditionCheck = NonNullable<NonNullable<TransactWriteCommandInput['TransactItems']>[number]['ConditionCheck']>;

/** Strip R7's optional `sha256:` wire prefix to R2's raw-hex form. */
export function rawHex(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const hex = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  return /^[a-f0-9]{64}$/.test(hex) ? hex : null;
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
/** R2 surrogate for R7's missing recordVersion, derived from the authoritative attempt. */
export const attemptRecordVersion = (attempt: number) => `r7-attempt-${attempt}`;

/** Map R7's terminal status to R2's execution status vocabulary. */
function r7Status(item: Record<string, unknown>): CompilationExecution['status'] | null {
  const s = item.status;
  if (s === 'SUCCEEDED' || s === 'FAILED' || s === 'RUNNING') return s === 'RUNNING' ? 'RUNNING' : s;
  if (s === 'PENDING') return 'QUEUED';
  return null;
}

async function loadMeta(client: DynamoDBDocumentClient, table: string, requestId: string, jobId: string): Promise<Record<string, unknown> | null> {
  const r = await client.send(new GetCommand({ TableName: table, Key: { pk: `JOB#${jobId}`, sk: 'META' }, ConsistentRead: true }));
  const item = r.Item as Record<string, unknown> | undefined;
  return item && item.requestId === requestId ? item : null;
}

/**
 * Build a CompilationExecution from R7's flat COMPILE_LOGIC JOB/META + the job
 * intent. Returns null if the authoritative record is missing required fields;
 * the ingestion service then fails closed (never fabricates evidence).
 */
export function compilationExecutionFromMeta(item: Record<string, unknown>, job: CompilationJobIntent): CompilationExecution | null {
  const status = r7Status(item);
  const attempt = int(item.attempt);
  const runnerActorId = str(item.leaseOwner) ?? str(item.runnerActorId);
  const startedAt = str(item.startedAt);
  if (!status || attempt === null || !runnerActorId || !startedAt) return null;
  const succeeded = status === 'SUCCEEDED';
  const finishedAt = str(item.finishedAt);
  const toolVersions = (item.toolVersions && typeof item.toolVersions === 'object' && !Array.isArray(item.toolVersions))
    ? item.toolVersions as Record<string, string> : {};
  const execution: CompilationExecution = {
    requestId: job.requestId, jobId: job.jobId, jobType: 'COMPILE_LOGIC', mode: 'approved',
    attempt, recordVersion: attemptRecordVersion(attempt), runnerActorId, status,
    requestPreview: job.requestPreview, logicModelRevision: job.logicModelRevision, logicModelHash: job.logicModelHash,
    clinicalApprovalId: job.clinicalApprovalId, jobWorkflowVersion: job.workflowVersion,
    inputHash: rawHex(item.inputHash), compileArtifactHash: rawHex(item.compileArtifactHash),
    artifactHash: rawHex(item.packageHash), // R7 packageHash == R2 packaged-object digest
    artifactUri: str(item.packageUri), artifactVersionId: str(item.packageVersionId),
    manifestUri: str(item.manifestUri), manifestHash: rawHex(item.manifestHash), manifestVersionId: str(item.manifestVersionId),
    reportUri: str(item.compileReportUri), reportHash: rawHex(item.compileReportHash), reportVersionId: str(item.compileReportVersionId),
    toolVersions, startedAt, finishedAt,
    compilerExitCode: succeeded ? 0 : (item.compilerExitCode === 1 || item.compilerExitCode === 2 ? item.compilerExitCode : null),
    chtConfStatus: succeeded ? 'PASSED' : (item.chtConfStatus === 'FAILED' ? 'FAILED' : 'NOT_RUN'),
    failureKind: succeeded ? null : (typeof item.failureKind === 'string' ? item.failureKind as CompilationExecution['failureKind'] : 'RUNNER_FAILED'),
    errorCode: succeeded ? null : (str(item.errorCode) ?? 'COMPILE_INFRA_ERROR'),
    errorMessage: succeeded ? null : (str(item.errorMessage) ?? 'Compilation failed.'),
    logUri: str(item.logUri), diagnostics: null,
  };
  return execution;
}

/** Build a VerificationExecution from R7's flat VERIFY_BUILD JOB/META + the job intent. */
export function verificationExecutionFromMeta(item: Record<string, unknown>, job: VerifyBuildJobIntent): VerificationExecution | null {
  const status = r7Status(item);
  const attempt = int(item.attempt);
  const runnerActorId = str(item.leaseOwner) ?? str(item.runnerActorId);
  const startedAt = str(item.startedAt);
  if (!status || attempt === null || !runnerActorId || !startedAt) return null;
  const succeeded = status === 'SUCCEEDED';
  return {
    requestId: job.requestId, jobId: job.jobId, jobType: 'VERIFY_BUILD', attempt,
    recordVersion: attemptRecordVersion(attempt), runnerActorId, status,
    requestPreview: job.requestPreview, logicModelRevision: job.logicModelRevision, logicModelHash: job.logicModelHash,
    clinicalApprovalId: job.clinicalApprovalId, compileJobId: job.compileJobId, jobWorkflowVersion: job.workflowVersion,
    reportUri: str(item.reportUri), reportHash: rawHex(item.reportHash), reportVersionId: str(item.reportVersionId),
    verificationPassed: bool(item.verificationPassed), coverageComplete: bool(item.coverageComplete),
    reportVersion: str(item.reportVersion),
    startedAt, finishedAt: str(item.finishedAt),
    errorCode: succeeded ? null : (str(item.errorCode) ?? 'VERIFY_ERROR'),
    errorMessage: succeeded ? null : (str(item.errorMessage) ?? 'Verification failed.'),
  };
}

/** A CompilationExecutionSource backed by R7's authoritative flat JOB/META. */
export function r7CompilationExecutionSource(client: DynamoDBDocumentClient, table: string, store: CompilationResultStore): CompilationExecutionSource {
  return {
    async getCurrent(requestId, jobId) {
      const item = await loadMeta(client, table, requestId, jobId);
      const job = await store.getCompilationJob(requestId, jobId);
      return item && job ? compilationExecutionFromMeta(item, job) : null;
    },
  };
}
/** A VerificationExecutionSource backed by R7's authoritative flat JOB/META. */
export function r7VerificationExecutionSource(client: DynamoDBDocumentClient, table: string, store: VerificationResultStore): VerificationExecutionSource {
  return {
    async getCurrent(requestId, jobId) {
      const item = await loadMeta(client, table, requestId, jobId);
      const job = await store.getVerifyBuildJob(requestId, jobId);
      return item && job ? verificationExecutionFromMeta(item, job) : null;
    },
  };
}

/**
 * Condition the finalization transaction on R7's REAL flat META attributes
 * (attempt + status), so a concurrent new attempt or status change cancels the
 * write. This gates on the exact attempt R2 read; the recordVersion surrogate is
 * derived from `attempt`, so no extra attribute is needed.
 */
export function r7CompilationCondition(table: string): NonNullable<DynamoStoreOptions['executionCondition']> {
  return (e) => ({
    TableName: table, Key: { pk: `JOB#${e.jobId}`, sk: 'META' },
    ConditionExpression: 'attempt = :a AND #s = :s',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':a': e.attempt, ':s': e.status },
  }) as ConditionCheck;
}
export function r7VerificationCondition(table: string): NonNullable<DynamoStoreOptions['verificationCondition']> {
  return (e) => ({
    TableName: table, Key: { pk: `JOB#${e.jobId}`, sk: 'META' },
    ConditionExpression: 'attempt = :a AND #s = :s',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':a': e.attempt, ':s': e.status },
  }) as ConditionCheck;
}
