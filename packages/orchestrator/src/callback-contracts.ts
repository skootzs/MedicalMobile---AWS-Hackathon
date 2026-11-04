import { canonicalizeJson } from './snapshots.ts';
import type { LogicModelSnapshot, Snapshot, SnapshotValidator } from './snapshots.ts';
import type { RevisionIdentity } from './routing.ts';
import type { LogicIdentity } from './workflow.ts';

/** Provisional metadata contracts only. R4 owns actual schemas/checker semantics. */
export interface LogicValidationReference {
  validatorId: string;
  validatorVersion: string;
  resultId: string;
  reportId?: string;
}
export interface PassedLogicValidation extends LogicValidationReference {
  status: 'PASSED';
  requestId: string;
  requestPreview: RevisionIdentity;
  logic: LogicIdentity;
  schemaVersion: string;
  hashPolicyVersion: string;
}
export type ProposalValidationResult = PassedLogicValidation | ({ status: 'FAILED' | 'UNAVAILABLE' } & Partial<LogicValidationReference>);
export interface LogicValidationBoundary {
  /** Existing replaceable synchronous schema boundary; must not transform input. */
  validateSnapshot: SnapshotValidator;
  /** Trusted backend R4 adapter, not worker-supplied success flags. */
  validateProposal(snapshot: LogicModelSnapshot): Promise<ProposalValidationResult | null>;
}
export interface DraftingResultRecord {
  requestId: string;
  jobId: string;
  eventId: string;
  requestPreview: RevisionIdentity;
  sourceWorkflowVersion: number;
  jobWorkflowVersion: number;
  acceptedWorkflowVersion: number;
  handoffEventId: string;
  logic: LogicIdentity;
  validation: PassedLogicValidation;
}
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v === v.trim() && v.length <= 100;
/** Metadata binding validation, not a replacement for R4's schema/checker or clinical review. */
export function validationMatches(value: unknown, snapshot: Snapshot): value is PassedLogicValidation {
  try {
    const v = JSON.parse(canonicalizeJson(value)) as PassedLogicValidation;
    if (!v || typeof v !== 'object' || Array.isArray(v) || snapshot.kind !== 'LOGIC_MODEL' || v.status !== 'PASSED' ||
        Object.keys(v).some(k => !['status', 'validatorId', 'validatorVersion', 'resultId', 'reportId', 'requestId', 'requestPreview', 'logic', 'schemaVersion', 'hashPolicyVersion'].includes(k)) ||
        !id(v.validatorId) || !id(v.validatorVersion) || !id(v.resultId) || v.reportId !== undefined && !id(v.reportId)) return false;
    return v.requestId === snapshot.requestId && v.schemaVersion === snapshot.schemaVersion && v.hashPolicyVersion === snapshot.hashPolicyVersion &&
      canonicalizeJson(v.requestPreview) === canonicalizeJson(snapshot.requestPreview) &&
      canonicalizeJson(v.logic) === canonicalizeJson({ logicRevision: snapshot.revision, logicHash: snapshot.snapshotHash });
  } catch { return false; }
}

/** Preserve traceable adapter references on rejected validation attempts, without asserting success. */
export function validationReference(value: unknown): LogicValidationReference | null {
  try {
    const v = JSON.parse(canonicalizeJson(value)) as LogicValidationReference;
    if (!v || !id(v.validatorId) || !id(v.validatorVersion) || !id(v.resultId) || v.reportId !== undefined && !id(v.reportId)) return null;
    return { validatorId: v.validatorId, validatorVersion: v.validatorVersion, resultId: v.resultId,
      ...(v.reportId === undefined ? {} : { reportId: v.reportId }) };
  } catch { return null; }
}
