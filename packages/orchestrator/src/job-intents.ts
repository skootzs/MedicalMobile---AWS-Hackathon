import { createHash } from 'node:crypto';
import { canonicalizeJson } from './snapshots.ts';
import type { RevisionIdentity } from './routing.ts';

/** Provisional R2/R3 envelope; metadata only, no generated clinical content. */
export interface DraftingJobIntent {
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly jobType: 'DRAFT_LOGIC';
  readonly requestId: string;
  readonly requestPreview: Readonly<RevisionIdentity>;
  /** READY_FOR_LOGIC_PROPOSAL version consumed by the handoff. */
  readonly sourceWorkflowVersion: number;
  /** DRAFTING_LOGIC version a future callback must bind to. */
  readonly workflowVersion: number;
  readonly routingEventId: string;
  readonly handoffEventId: string;
}
export type WorkerOutcome = 'ACCEPTED' | 'UNAVAILABLE' | 'FAILED' | 'DUPLICATE';
export interface WorkerResult { outcome: WorkerOutcome; jobId: string; idempotencyKey: string }
export interface DraftingWorker { deliver(intent: DraftingJobIntent): Promise<WorkerResult> }
/** Stable IDs for a logical job, not snapshot or artifact hashes. Pure metadata factory. */
export function createDraftingIntent(request: RevisionIdentity, sourceWorkflowVersion: number, routingEventId: string, handoffEventId: string): DraftingJobIntent {
  if (!Number.isSafeInteger(sourceWorkflowVersion) || sourceWorkflowVersion < 1 || !Number.isSafeInteger(sourceWorkflowVersion + 1)) throw Error('Invalid job version.');
  const preview = { requestId: request.requestId, revision: request.revision, snapshotHash: request.snapshotHash };
  if (typeof preview.requestId !== 'string' || !preview.requestId.trim() || !Number.isSafeInteger(preview.revision) || preview.revision < 1 ||
      typeof preview.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(preview.snapshotHash) ||
      ![routingEventId, handoffEventId].every(id => typeof id === 'string' && !!id.trim())) throw Error('Invalid job identity.');
  const digest = createHash('sha256').update(canonicalizeJson({ namespace: 'draft-logic-job-v1', request: preview,
    sourceWorkflowVersion, routingEventId }), 'utf8').digest('hex');
  return Object.freeze({ jobId: `draft-${digest}`, idempotencyKey: `draft-logic-v1:${digest}`, jobType: 'DRAFT_LOGIC',
    requestId: request.requestId, requestPreview: Object.freeze(preview), sourceWorkflowVersion,
    workflowVersion: sourceWorkflowVersion + 1, routingEventId, handoffEventId });
}
