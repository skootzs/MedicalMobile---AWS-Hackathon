import type { AcceptedCheckerResult, CheckerReport } from '../checker-contracts.ts';
import type { Actor, WorkflowEvent, WorkflowState } from '../workflow.ts';
import type { RevisionIdentity } from '../routing.ts';
import type { DraftingResultRecord, LogicValidationReference } from '../callback-contracts.ts';
import type { DraftingJobIntent } from '../job-intents.ts';
import type { Snapshot, SnapshotValidator } from '../snapshots.ts';
import type { AuditRecord, EventReceipt } from './audit.ts';
import type { EvidenceRecord } from './artifacts.ts';

/** Provisional R2 storage contracts; R4 still owns shared schemas. */
type WithoutActor<T> = T extends WorkflowEvent ? Omit<T, 'actor'> : never;
export type WorkflowCommand = WithoutActor<WorkflowEvent>;
export type SnapshotKey =
  | { requestId: string; kind: 'REQUEST_PREVIEW'; revision: number }
  | { requestId: string; kind: 'LOGIC_MODEL'; revision: number; requestPreview: RevisionIdentity };
export interface ApplyCommand {
  /** Server-assigned id for one attempt; separate from the idempotent eventId. */
  attemptId: string;
  requestId: string;
  event: WorkflowCommand;
  snapshots?: readonly Snapshot[];
  /** Only valid with START_LOGIC_PROPOSAL; store verifies authoritative bindings. */
  jobIntent?: DraftingJobIntent;
  /** Authenticated callback metadata; only valid with LOGIC_PROPOSED. */
  draftingResult?: DraftingResultRecord;
  /** Audit-only provider references; never permission or a passing checker record. */
  callbackValidation?: LogicValidationReference;
  checkerResult?: AcceptedCheckerResult;
  /** Well-formed report preserved on a blocked/rejected attempt, never approval authority. */
  checkerAttempt?: CheckerReport;
  /** Internal application guards; these can reject, never grant permission. */
  expectedActorId?: string;
  preconditionFailure?: string;
  /** Hash of the complete validated application command, including evidence refs. */
  commandFingerprint?: string;
}
export interface ApplyResult {
  outcome: 'ACCEPTED' | 'REJECTED' | 'DUPLICATE';
  reason: string;
  version: number | null;
  auditId: string;
  /** Same attempt was already recorded; original result/audit are returned. */
  replayed: boolean;
}
/** Internal backend repository, not a public API. No direct setState/putApproval. */
export interface OrchestratorStore {
  apply(command: ApplyCommand, principal: unknown): Promise<ApplyResult>;
  getWorkflow(requestId: string): Promise<WorkflowState | null>;
  getSnapshot(key: SnapshotKey): Promise<Snapshot | null>;
  listSnapshots(requestId: string): Promise<readonly Snapshot[]>;
  getReceipt(requestId: string, eventId: string): Promise<EventReceipt | null>;
  listEvidence(requestId: string): Promise<readonly EvidenceRecord[]>;
  listAudit(requestId: string): Promise<readonly AuditRecord[]>;
}
export interface StoreDependencies {
  /** Must resolve authenticated backend identities; test resolver is not real auth. */
  resolveActor(principal: unknown, requestId: string): Actor | null | Promise<Actor | null>;
  validateSnapshot: SnapshotValidator;
  /** Backend clock; tests can inject a fixed ISO timestamp. */
  now?: () => string;
}
export class StorageError extends Error {
  readonly code: string;
  constructor(code: string, message = code) { super(message); this.name = 'StorageError'; this.code = code; }
}

/** Read-only internal discovery port. Candidate IDs are not authorized queue items.
 * A durable adapter should use a status index and add scoped pagination later. */
export interface ReviewCandidateSource {
  listReviewCandidates(status: WorkflowState['status']): Promise<readonly string[]>;
}
