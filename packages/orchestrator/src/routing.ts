/** Provisional local contracts. Shared schema ownership remains with workstream 4. */
export interface RevisionIdentity {
  requestId: string;
  revision: number;
  /** SHA-256 of the agreed canonical snapshot: exactly 64 lowercase hex digits. */
  snapshotHash: string;
}

export interface DesignBrief extends RevisionIdentity {
  title: string;
  objective: string;
  targetPopulation: string;
  intakeEvidenceHash?: string;
  requirements: ReadonlyArray<{ condition: string; action: string }>;
}

export const screeningAreas = [
  'completeness', 'ambiguities', 'contradictions', 'clinicalSafety', 'feasibility',
] as const;
export type ScreeningArea = typeof screeningAreas[number];

export interface PreliminaryScreening extends RevisionIdentity {
  screeningId: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  checks: Record<ScreeningArea, {
    outcome: 'CLEAR' | 'NEEDS_REVIEW' | 'NOT_ASSESSED';
    /** Empty for CLEAR; at least one unresolved concern for NEEDS_REVIEW. */
    reasons: readonly string[];
  }>;
}

export interface POConfirmation extends RevisionIdentity {
  confirmationId: string;
  screeningId: string;
  decision: 'CONFIRMED' | 'REVISION_REQUESTED';
}

/**
 * Internal server-side input, NOT an HTTP/browser payload. The future caller
 * must load currentRevision/currentScreeningId and records from authoritative
 * storage after authentication and schema validation. There is no trusted:true
 * shortcut. This pure function cannot authenticate records or verify hash content.
 */
export interface RoutingInput {
  currentRevision: RevisionIdentity;
  currentScreeningId: string;
  brief: DesignBrief;
  screening: PreliminaryScreening;
  confirmation: POConfirmation;
}

export type Route = 'NEEDS_SD_REVIEW' | 'READY_FOR_BEDROCK_REVIEW';
export interface RoutingReason {
  code: 'INVALID_INPUT' | 'MISSING_REQUIRED_INFORMATION' | 'STALE_EVIDENCE'
    | 'SCREENING_INCOMPLETE' | 'SCREENING_FAILED' | 'PO_NOT_CONFIRMED'
    | 'CONFLICTING_EVIDENCE' | 'REVIEW_REQUIRED' | 'CONTRADICTION'
    | 'READY_FOR_AI_REVIEW';
  field: string;
  message: string;
}

export interface RoutingResult {
  requestId: string | null;
  revision: number | null;
  snapshotHash: string | null;
  screeningId: string | null;
  confirmationId: string | null;
  /** NOT_READY is an eligibility failure; it must not create an SD task. */
  route: 'NOT_READY' | Route;
  reasons: RoutingReason[];
  /** Always required later. SD clarification and PO/AI decisions cannot waive it. */
  clinicalApprovalRequired: true;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function identifier(value: unknown): value is string {
  return text(value) && value === value.trim();
}
function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function identity(value: unknown): value is RevisionIdentity {
  return record(value) && identifier(value.requestId) && revision(value.revision) && hash(value.snapshotHash);
}

/**
 * Eligibility gate followed by deterministic routing, for ordinary JSON values.
 * No side effects: no queues, model calls, approvals, or release permissions.
 * Hashes are compared, never invented or recomputed without the canonical snapshot.
 */
export function routeDesignBrief(input: unknown): RoutingResult {
  const envelope = record(input) ? input : {};
  const current = record(envelope.currentRevision) ? envelope.currentRevision : {};
  const screening = record(envelope.screening) ? envelope.screening : {};
  const confirmation = record(envelope.confirmation) ? envelope.confirmation : {};
  const blocked: RoutingReason[] = [];
  const review: RoutingReason[] = [];
  const add = (code: RoutingReason['code'], field: string, message: string) => {
    blocked.push({ code, field, message });
  };
  const finish = (route: RoutingResult['route'], reasons: RoutingReason[]): RoutingResult => ({
    requestId: identifier(current.requestId) ? current.requestId : null,
    revision: revision(current.revision) ? current.revision : null,
    snapshotHash: hash(current.snapshotHash) ? current.snapshotHash : null,
    screeningId: identifier(screening.screeningId) ? screening.screeningId : null,
    confirmationId: identifier(confirmation.confirmationId) ? confirmation.confirmationId : null,
    route, reasons, clinicalApprovalRequired: true,
  });

  if (!record(input)) add('INVALID_INPUT', 'input', 'An authoritative routing envelope is required.');
  for (const field of ['currentRevision', 'brief', 'screening', 'confirmation']) {
    const evidence = envelope[field];
    if (!identity(evidence)) {
      add('INVALID_INPUT', field, 'A request ID, positive integer revision, and lowercase SHA-256 snapshot hash are required.');
    } else if (identity(envelope.currentRevision) && (
      evidence.requestId !== envelope.currentRevision.requestId ||
      evidence.revision !== envelope.currentRevision.revision ||
      evidence.snapshotHash !== envelope.currentRevision.snapshotHash
    )) {
      add('STALE_EVIDENCE', field, 'Evidence must match the authoritative current request revision and snapshot hash exactly.');
    }
  }
  if (!record(envelope.brief)) {
    add('INVALID_INPUT', 'brief', 'A DesignBrief object is required.');
  }
  if (!identifier(envelope.currentScreeningId) || !identifier(screening.screeningId) ||
      !identifier(confirmation.screeningId) || !identifier(confirmation.confirmationId)) {
    add('INVALID_INPUT', 'evidenceIds', 'Current screening, screening record, and confirmation IDs are required.');
  } else if (envelope.currentScreeningId !== screening.screeningId ||
             confirmation.screeningId !== screening.screeningId) {
    add('CONFLICTING_EVIDENCE', 'screeningId', 'Confirmation and screening must reference the authoritative current screening attempt.');
  }

  if (screening.status === 'FAILED') {
    add('SCREENING_FAILED', 'screening.status', 'Failed screening does not establish eligibility.');
  } else if (screening.status === 'PENDING') {
    add('SCREENING_INCOMPLETE', 'screening.status', 'Screening must complete before routing.');
  } else if (screening.status !== 'COMPLETED') {
    add('INVALID_INPUT', 'screening.status', 'Screening status must be PENDING, COMPLETED, or FAILED.');
  }
  if (confirmation.decision === 'REVISION_REQUESTED') {
    add('PO_NOT_CONFIRMED', 'confirmation.decision', 'The PO requested revisions; the current interpretation is not confirmed.');
  } else if (confirmation.decision !== 'CONFIRMED') {
    add('PO_NOT_CONFIRMED', 'confirmation.decision', 'Explicit PO confirmation is required.');
  }

  if (!record(screening.checks)) {
    add('INVALID_INPUT', 'screening.checks', 'All five screening assessments are required.');
  } else {
    if (Object.keys(screening.checks).some(key => !screeningAreas.some(area => area === key))) {
      add('INVALID_INPUT', 'screening.checks', 'Unknown assessment areas require contract clarification.');
    }
    for (const area of screeningAreas) {
      const check = screening.checks[area];
      const field = `screening.checks.${area}`;
      if (!record(check) || !Array.isArray(check.reasons) ||
          Array.from(check.reasons).some(reason => !text(reason))) {
        add('INVALID_INPUT', field, 'An assessment with an explicit array of non-empty reason strings is required.');
        continue;
      }
      if (check.outcome === 'NOT_ASSESSED') {
        add('SCREENING_INCOMPLETE', field, 'Every area must be assessed before routing.');
      } else if (check.outcome === 'CLEAR') {
        if (check.reasons.length > 0) add('CONFLICTING_EVIDENCE', field, 'CLEAR cannot contain unresolved concerns.');
      } else if (check.outcome === 'NEEDS_REVIEW') {
        if (check.reasons.length === 0) {
          add('CONFLICTING_EVIDENCE', field, 'NEEDS_REVIEW must explain at least one unresolved concern.');
        } else {
          for (const message of check.reasons) review.push({ code: 'REVIEW_REQUIRED', field, message });
        }
      } else {
        add('INVALID_INPUT', field, 'Unknown assessment outcome.');
      }
    }
  }

  // Invalid prerequisites never become SD work, even if other records contain concerns.
  if (blocked.length > 0) return finish('NOT_READY', blocked);

  const brief = envelope.brief as unknown as DesignBrief;
  for (const field of ['title', 'objective', 'targetPopulation'] as const) {
    if (!text(brief[field])) review.push({ code: 'MISSING_REQUIRED_INFORMATION', field: `brief.${field}`, message: 'A non-empty string is required.' });
  }
  if (!Array.isArray(brief.requirements) || brief.requirements.length === 0) {
    review.push({ code: 'MISSING_REQUIRED_INFORMATION', field: 'brief.requirements', message: 'At least one condition/action requirement is required.' });
  } else {
    const actions = new Map<string, string>();
    for (const [index, requirement] of Array.from(brief.requirements).entries()) {
      const field = `brief.requirements[${index}]`;
      if (!record(requirement) || !text(requirement.condition) || !text(requirement.action)) {
        review.push({ code: 'MISSING_REQUIRED_INFORMATION', field, message: 'A non-empty condition and action are required.' });
        continue;
      }
      // Preserve case-sensitive identifiers; normalization does not interpret semantics.
      const condition = requirement.condition.trim().replace(/\s+/g, ' ');
      const action = requirement.action.trim().replace(/\s+/g, ' ');
      if (actions.has(condition) && actions.get(condition) !== action) {
        review.push({ code: 'CONTRADICTION', field, message: 'The same condition specifies different actions; clarify intent.' });
      }
      actions.set(condition, action);
    }
  }
  if (review.length > 0) return finish('NEEDS_SD_REVIEW', review);
  return finish('READY_FOR_BEDROCK_REVIEW', [{
    code: 'READY_FOR_AI_REVIEW', field: 'brief',
    message: 'Current screening and PO confirmation match. Downstream review may be scheduled separately; clinician approval, developer verification, and release approval remain mandatory.',
  }]);
}
