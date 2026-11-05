/**
 * Reads the job-events queue and calls JobCompletionReconciler.
 *
 * The events Pipe sends { requestId, jobId, status, attempt }. attempt is a
 * numeric string because a Pipe renders every stream value as a string.
 * The consumer picks cht-runner-compile or cht-runner-verify from jobType on
 * JOB#id/META, then the reconciler ingests that attempt.
 */
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { JobCompletionNotification, JobCompletionReconciler } from './reconciler.ts';
import { RUNNER_COMPILE_ACTOR_ID, RUNNER_VERIFY_ACTOR_ID, runnerPrincipal } from './service-actors.ts';

export interface ParsedJobEvent {
  requestId?: string;
  jobId: string;
  status?: JobCompletionNotification['status'];
  attempt: number | string;
  jobType?: 'COMPILE_LOGIC' | 'VERIFY_BUILD';
}

const STATUSES = new Set(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED']);

/** The Pipe body, or null when it cannot be reconciled. */
export function parseJobEventBody(body: string): ParsedJobEvent | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (typeof row.jobId !== 'string' || !row.jobId.trim()) return null;
  const attempt = row.attempt;
  const attemptOk = (typeof attempt === 'number' && Number.isSafeInteger(attempt) && attempt >= 1)
    || (typeof attempt === 'string' && /^[1-9][0-9]*$/.test(attempt));
  if (!attemptOk) return null;
  const status = typeof row.status === 'string' && STATUSES.has(row.status) ? row.status as JobCompletionNotification['status'] : undefined;
  const jobType = row.jobType === 'COMPILE_LOGIC' || row.jobType === 'VERIFY_BUILD' ? row.jobType : undefined;
  const requestId = typeof row.requestId === 'string' && row.requestId.trim() ? row.requestId : undefined;
  return { requestId, jobId: row.jobId, status, attempt: attempt as number | string, jobType };
}

export function runnerPrincipalForJob(jobType: string | undefined): ReturnType<typeof runnerPrincipal> | null {
  if (jobType === 'COMPILE_LOGIC') return runnerPrincipal(RUNNER_COMPILE_ACTOR_ID);
  if (jobType === 'VERIFY_BUILD') return runnerPrincipal(RUNNER_VERIFY_ACTOR_ID);
  return null;
}

export interface JobEventDeps {
  queueUrl: string;
  sqs: Pick<SQSClient, 'send'>;
  reconciler: Pick<JobCompletionReconciler, 'reconcile'>;
  /** Reads jobType from JOB#id/META when the Pipe body does not include it. */
  jobType(jobId: string): Promise<string | null>;
  log?(message: string, detail?: unknown): void;
}

/** One long-poll. Returns how many messages were reconciled. */
export async function pollJobEventsOnce(deps: JobEventDeps): Promise<number> {
  const received = await deps.sqs.send(new ReceiveMessageCommand({
    QueueUrl: deps.queueUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 20,
  }));
  let handled = 0;
  for (const message of received.Messages ?? []) {
    const event = parseJobEventBody(message.Body ?? '');
    if (!event) {
      deps.log?.('job-events message dropped', { messageId: message.MessageId });
      continue;
    }
    const jobType = event.jobType ?? await deps.jobType(event.jobId) ?? undefined;
    const principal = runnerPrincipalForJob(jobType);
    if (!principal) {
      deps.log?.('job-events job has no runner actor', { jobId: event.jobId, jobType });
      continue;
    }
    const result = await deps.reconciler.reconcile({
      requestId: event.requestId,
      jobId: event.jobId,
      status: event.status,
      attempt: event.attempt,
      jobType: jobType === 'COMPILE_LOGIC' || jobType === 'VERIFY_BUILD' ? jobType : undefined,
    }, principal);
    deps.log?.('job-events reconciled', { jobId: event.jobId, status: result.status, reason: result.reason });
    if (result.status !== 'STORAGE_FAILURE' && message.ReceiptHandle) {
      await deps.sqs.send(new DeleteMessageCommand({ QueueUrl: deps.queueUrl, ReceiptHandle: message.ReceiptHandle }));
      handled += 1;
    }
  }
  return handled;
}
