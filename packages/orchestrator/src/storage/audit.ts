import type { ProposedAuditEvent } from '../workflow.ts';
import type { RevisionIdentity } from '../routing.ts';

/** Append-only proposed workflow audit plus backend recording metadata. */
export interface AuditRecord extends ProposedAuditEvent {
  auditId: string;
  sequence: number;
  recordedAt: string;
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
}
