import type { ProposedAuditEvent } from '../workflow.ts';
import type { RevisionIdentity, RoutingResult } from '../routing.ts';

/** Append-only proposed workflow audit plus backend recording metadata. */
export interface AuditRecord extends ProposedAuditEvent {
  auditId: string;
  sequence: number;
  recordedAt: string;
  /** Accepted APPLY_ROUTING only: exact decision and evidence references. */
  routing?: RoutingResult;
}
export interface EventReceipt {
  request: RevisionIdentity;
  eventId: string;
  /** Existing workflow event fingerprint, not a content snapshot hash. */
  fingerprint: string;
  workflowVersion: number;
  auditId: string;
  /** Optional for commands predating the application-service boundary. */
  commandFingerprint?: string;
  /** Immutable accepted routing decision; absent on older/non-routing receipts. */
  routing?: RoutingResult;
}
