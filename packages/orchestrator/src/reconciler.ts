/**
 * Job-completion reconciler (R2-owned machine-to-machine entry point).
 *
 * TRANSPORT OWNERSHIP: R7 owns the queues and the runner. When a job reaches a
 * terminal status, R7's Events Pipe delivers `{ jobId, status, attempt }` to the
 * `job-events` queue (docs/job-delivery.md, Tier 3); the documented fallback is
 * R2 polling job status. EITHER WAY, the queue consumer / poller invokes THIS
 * reconciler. This is the exact R2 interface R7 must call — it is NOT a public,
 * unauthenticated HTTP callback. The caller must present a trusted service
 * principal (resolved to a COMPILER / VERIFIER / DRAFTER / CHECKER actor), and
 * the reconciler re-reads the AUTHORITATIVE `JOB#<jobId>/META` record itself
 * rather than trusting anything in the notification beyond the jobId/requestId.
 *
 * The notification is only a hint of WHICH job to reconcile; all evidence comes
 * from the authoritative R7 record + R2's own stored job intent, and the
 * underlying ingestion services re-validate everything and fail closed.
 */
import { createHash } from 'node:crypto';
import type { CompilationResultService } from './compilation-results.ts';
import type { VerificationResultService } from './verification-results.ts';
import type { VerificationResultStore } from './storage/verification-results.ts';
import type { CompilationResultStore } from './storage/compilation-results.ts';

/** The minimal, trusted notification R7 delivers (or R2 polls) per terminal job. */
export interface JobCompletionNotification {
  /** Present when the caller already knows the request. The events Pipe sends only jobId, status and attempt. */
  requestId?: string;
  jobId: string;
  /** Hint only; the authoritative job type is confirmed from the stored intent. */
  jobType?: 'COMPILE_LOGIC' | 'VERIFY_BUILD';
  /** Hint only. The pipe includes it; the reconciler re-reads JOB/META. */
  status?: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  /** R7's attempt counter from the event; the reconciler re-reads the record. */
  attempt: number;
}
export type ReconcileStatus =
  | 'RECONCILED' | 'DUPLICATE' | 'STALE' | 'BLOCKED' | 'REJECTED' | 'UNKNOWN_JOB' | 'STORAGE_FAILURE';
export interface ReconcileResult {
  status: ReconcileStatus;
  jobType: 'COMPILE_LOGIC' | 'VERIFY_BUILD' | null;
  reason: string;
  workflowVersion: number | null;
}

export interface ReconcilerDependencies {
  /** Store that can look up which kind of job a jobId is. */
  store: CompilationResultStore & VerificationResultStore;
  /** Reads requestId off JOB#id/META when the events Pipe omitted it. */
  resolveRequestId?(jobId: string): Promise<string | null>;
  compilation: Pick<CompilationResultService, 'ingest'>;
  verification: Pick<VerificationResultService, 'ingest'>;
  /** Deterministic event id for the ingestion command, derived from the job+attempt. */
  resultEventId?(jobType: string, jobId: string, attempt: number): string;
}

// Deterministic, <=100-char idempotent result event id (jobId can be 70+ chars).
const defaultEventId = (jobType: string, jobId: string, attempt: number) =>
  `result-${jobType === 'VERIFY_BUILD' ? 'v' : 'c'}-${createHash('sha256').update(`${jobType}:${jobId}:${attempt}`).digest('hex')}`;
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.trim() === v && v.length <= 100;
const attemptOk = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

/**
 * The R7 consumer calls reconcile() with a verified service principal. The
 * principal must resolve (inside the ingestion service) to a COMPILER actor for
 * a COMPILE_LOGIC job or a VERIFIER actor for a VERIFY_BUILD job; otherwise the
 * ingestion service rejects it. This router never grants authority itself.
 */
export class JobCompletionReconciler {
  #deps: ReconcilerDependencies;
  constructor(deps: ReconcilerDependencies) {
    if (!deps?.store || typeof deps.store.getCompilationJob !== 'function' || typeof deps.store.getVerifyBuildJob !== 'function' ||
        typeof deps.compilation?.ingest !== 'function' || typeof deps.verification?.ingest !== 'function') {
      throw new Error('Reconciler requires a job store and the compilation + verification ingestion services.');
    }
    this.#deps = deps;
  }

  async reconcile(notification: JobCompletionNotification, principal: unknown): Promise<ReconcileResult> {
    const reply = (status: ReconcileStatus, jobType: ReconcileResult['jobType'], reason: string, workflowVersion: number | null = null): ReconcileResult =>
      ({ status, jobType, reason, workflowVersion });
    if (!notification || !id(notification.jobId) || !attemptOk(notification.attempt)) {
      return reply('REJECTED', null, 'INVALID_NOTIFICATION');
    }
    let requestId = notification.requestId;
    if (!id(requestId)) {
      if (!this.#deps.resolveRequestId) return reply('REJECTED', null, 'INVALID_NOTIFICATION');
      try { requestId = (await this.#deps.resolveRequestId(notification.jobId)) ?? undefined; }
      catch { return reply('STORAGE_FAILURE', null, 'SERVICE_UNAVAILABLE'); }
      if (!id(requestId)) return reply('UNKNOWN_JOB', null, 'JOB_NOT_FOUND');
    }
    const { jobId, attempt } = notification;
    const eventId = (this.#deps.resultEventId ?? defaultEventId);
    try {
      // Confirm the authoritative job type from R2's stored intent (not the hint).
      const compileJob = await this.#deps.store.getCompilationJob(requestId, jobId);
      if (compileJob) {
        const r = await this.#deps.compilation.ingest(
          { requestId, jobId, eventId: eventId('COMPILE_LOGIC', jobId, attempt), expectedVersion: compileJob.workflowVersion, attempt, executionRecordVersion: `r7-attempt-${attempt}` },
          principal,
        );
        return reply(this.#map(r.status), 'COMPILE_LOGIC', r.reason, r.workflowVersion);
      }
      const verifyJob = await this.#deps.store.getVerifyBuildJob(requestId, jobId);
      if (verifyJob) {
        const r = await this.#deps.verification.ingest(
          { requestId, jobId, eventId: eventId('VERIFY_BUILD', jobId, attempt), expectedVersion: verifyJob.workflowVersion, attempt, executionRecordVersion: `r7-attempt-${attempt}` },
          principal,
        );
        return reply(this.#map(r.status), 'VERIFY_BUILD', r.reason, r.workflowVersion);
      }
      return reply('UNKNOWN_JOB', null, 'JOB_NOT_FOUND');
    } catch {
      return reply('STORAGE_FAILURE', null, 'SERVICE_UNAVAILABLE');
    }
  }

  #map(status: string): ReconcileStatus {
    switch (status) {
      case 'ACCEPTED': return 'RECONCILED';
      case 'DUPLICATE_EVENT': return 'DUPLICATE';
      case 'STALE_VERSION': return 'STALE';
      case 'BLOCKED': return 'BLOCKED';
      case 'STORAGE_FAILURE': return 'STORAGE_FAILURE';
      default: return 'REJECTED';
    }
  }
}
