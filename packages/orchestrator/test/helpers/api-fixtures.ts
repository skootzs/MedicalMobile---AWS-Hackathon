/** TEST ONLY: fictional opaque session mapping. Never import this from src/. */
import type { AuthenticationBoundary } from '../../src/auth.ts';
import type { ClinicalDecisionBody, ReleaseDecisionBody } from '../../src/routes/approve.ts';
import type { OrchestratorStore } from '../../src/storage/requests.ts';
import type { WorkflowState } from '../../src/workflow.ts';

export const sessionHeaders = (name: string) => ({ authorization: `Bearer fictional-session-${name}` });
const sessions = new Map(['po', 'clinic', 'release', 'poClinic', 'clinicRelease', 'outsider']
  .map(name => [`Bearer fictional-session-${name}`, name]));
export const testAuthentication: AuthenticationBoundary = {
  authenticate(request) {
    const header = request.headers.authorization;
    const context = typeof header === 'string' ? sessions.get(header) : undefined;
    return context === undefined ? null : Object.freeze({ context });
  },
  canAccessRequest(principal, requestId) {
    return principal.context !== 'outsider' && requestId.startsWith('fictional-');
  },
};
export function clinicalBody(s: WorkflowState): ClinicalDecisionBody {
  return { eventId: `http-clinical-${s.version}`, expectedVersion: s.version,
    requestRevision: s.brief.revision, requestSnapshotHash: s.brief.snapshotHash,
    logicRevision: s.logic?.logicRevision ?? 1, logicHash: s.logic?.logicHash ?? 'a'.repeat(64),
    checkerReportId: s.checks?.reportId ?? 'not-checked', decision: 'APPROVE' };
}
export function releaseBody(s: WorkflowState): ReleaseDecisionBody {
  return { eventId: `http-release-${s.version}`, expectedVersion: s.version,
    requestRevision: s.brief.revision, requestSnapshotHash: s.brief.snapshotHash,
    logicRevision: s.logic?.logicRevision ?? 1, logicHash: s.logic?.logicHash ?? 'a'.repeat(64),
    clinicalApprovalEventId: s.clinicalApproval?.eventId ?? 'missing-clinical', compilationId: s.artifact?.compilationId ?? 'missing-artifact',
    artifactHash: s.artifact?.artifactHash ?? 'a'.repeat(64), verificationId: s.verification?.verificationId ?? 'missing-verification',
    verificationReportHash: s.verification?.reportHash ?? 'b'.repeat(64), decision: 'APPROVE' };
}
export function wrapStore(db: OrchestratorStore, changes: Partial<OrchestratorStore>): OrchestratorStore {
  return { apply: (c,p) => db.apply(c,p), getWorkflow: id => db.getWorkflow(id), getSnapshot: key => db.getSnapshot(key),
    listSnapshots: id => db.listSnapshots(id), getReceipt: (id,event) => db.getReceipt(id,event),
    listEvidence: id => db.listEvidence(id), listAudit: id => db.listAudit(id), ...changes };
}
