import type { CompilationResultRecord } from '../compilation-result-contracts.ts';
import type { VerificationResultRecord } from '../verification-result-contracts.ts';
import type { AcceptedCheckerResult } from '../checker-contracts.ts';
import type { WorkflowEvent } from '../workflow.ts';

/** Immutable accepted evidence history, including rejected/returned review decisions. */
export type EvidenceEvent = Extract<WorkflowEvent, {
  type: 'SCREENING_COMPLETED' | 'PO_DECISION' | 'LOGIC_CHECKED' | 'CLINICAL_DECISION'
    | 'COMPILED' | 'VERIFIED' | 'RELEASE_DECISION';
}>;
export interface EvidenceRecord {
  requestId: string;
  kind: EvidenceEvent['type'];
  recordId: string;
  event: EvidenceEvent;
  checkerResult?: AcceptedCheckerResult;
  compilationResult?: CompilationResultRecord;
  verificationResult?: VerificationResultRecord;
}
/** Only called for a transition accepted by workflow.ts. Never a public approval writer. */
export function evidenceFromEvent(event: WorkflowEvent): EvidenceRecord | null {
  let recordId: string;
  switch (event.type) {
    case 'SCREENING_COMPLETED': recordId = event.screening.screeningId; break;
    case 'PO_DECISION': recordId = event.confirmation.confirmationId; break;
    case 'LOGIC_CHECKED': recordId = event.reportId; break;
    case 'COMPILED': recordId = event.artifact.compilationId; break;
    case 'VERIFIED': recordId = event.evidence.verificationId; break;
    case 'CLINICAL_DECISION': case 'RELEASE_DECISION': recordId = event.eventId; break;
    default: return null;
  }
  return { requestId: event.request.requestId, kind: event.type, recordId, event: structuredClone(event) };
}
