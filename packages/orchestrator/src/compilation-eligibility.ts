import { evidenceFailure } from './approvals.ts';
import { checkerEvidenceMatches, checkerSame } from './checker-contracts.ts';
import { transitionWorkflow } from './workflow.ts';
import type { WorkflowState } from './workflow.ts';
import type { Snapshot } from './snapshots.ts';
import type { EvidenceRecord } from './storage/artifacts.ts';
import type { EventReceipt } from './storage/audit.ts';

/** Shared read-time and atomic commit check. Reuses existing approval evidence/role guards. */
export function compilationEvidenceFailure(s: WorkflowState, preview: Snapshot | null, model: Snapshot | null,
  records: readonly EvidenceRecord[], clinicalReceipt: EventReceipt | null, checkerReceipt: EventReceipt | null): string | undefined {
  const request = { requestId: s.brief.requestId, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash };
  if (!s.logic) return 'LOGIC_REQUIRED';
  const failure = evidenceFailure({ type: 'CLINICAL_DECISION', requestId: request.requestId, requestRevision: request.revision, requestSnapshotHash: request.snapshotHash,
    expectedVersion: s.version, ...s.logic, checkerReportId: s.checks?.reportId ?? '', eventId: 'compilation-evidence-probe', decision: 'APPROVE' }, s, preview, model, records);
  if (failure) return failure;
  const check = records.filter(r => r.kind === 'LOGIC_CHECKED' && r.recordId === s.checks?.reportId && r.requestId === request.requestId && checkerSame(r.event.request, request));
  if (check.length !== 1 || check[0].event.type !== 'LOGIC_CHECKED' || !s.checks?.invocationId ||
      !checkerEvidenceMatches(check[0].checkerResult, { request, logic: s.logic, reportId: s.checks.reportId, eventId: check[0].event.eventId,
        invocationId: s.checks.invocationId, passed: true, actorId: check[0].event.actor.id })) return 'FORMAL_CHECKER_EVIDENCE_REQUIRED';
  const approval = s.clinicalApproval;
  if (!approval || !checkerSame({ logicRevision: approval.logicRevision, logicHash: approval.logicHash }, s.logic)) return 'CLINICAL_APPROVAL_REQUIRED';
  const clinical = records.filter(r => r.kind === 'CLINICAL_DECISION' && r.requestId === request.requestId && r.recordId === approval.eventId && checkerSame(r.event.request, request));
  const event = clinical.length === 1 ? clinical[0].event : null;
  if (!event || event.type !== 'CLINICAL_DECISION' || event.decision !== 'APPROVE' || event.actor.id !== approval.actorId ||
      event.logicRevision !== s.logic.logicRevision || event.logicHash !== s.logic.logicHash) return 'CLINICAL_APPROVAL_REQUIRED';
  for (const [receipt, original] of [[clinicalReceipt, event], [checkerReceipt, check[0].event]] as const) {
    if (!receipt || receipt.eventId !== original.eventId || !checkerSame(receipt.request, request) || receipt.workflowVersion !== original.expectedVersion + 1 ||
        !s.processedEvents.some(e => e.eventId === receipt.eventId && e.fingerprint === receipt.fingerprint)) return 'APPROVAL_RECEIPT_REQUIRED';
  }
  // Probe the original decision with its original actor through the same independence
  // guard; this is discarded, never saved as a second clinical decision.
  const probe = transitionWorkflow({ ...s, status: 'WAITING_FOR_CLINICAL_APPROVAL', version: event.expectedVersion, clinicalApproval: null,
    processedEvents: s.processedEvents.filter(e => e.eventId !== event.eventId) }, event);
  if (probe.outcome !== 'ACCEPTED' || !checkerSame(probe.state?.clinicalApproval, approval)) return 'INVALID_CLINICAL_APPROVAL';
}
