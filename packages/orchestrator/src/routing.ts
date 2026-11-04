/** Provisional intake screening states; not clinical approval states. */
export type ScreeningStatus = 'NOT_ASSESSED' | 'ASSESSED';

/**
 * Provisional intake contract, local to this package until the schema owner
 * agrees a shared DesignBrief. Use public or fictional workflow data only.
 *
 * Each requirement describes one condition and its requested action. Conditions
 * must use consistent wording: this router cannot interpret clinical prose.
 * All review flag arrays must be supplied, including explicit empty arrays.
 * They report upstream screening findings; they are not clinical sign-off.
 */
export interface DesignBrief {
  requestId: string;
  title: string;
  objective: string;
  targetPopulation: string;
  /**
   * Client-provided status is not independently verified by this pure router.
   * A future authenticated server-side screening process must establish it.
   */
  screeningStatus: ScreeningStatus;
  requirements: ReadonlyArray<{ condition: string; action: string }>;
  reviewFlags: {
    ambiguities: readonly string[];
    contradictions: readonly string[];
    clinicalSafetyConcerns: readonly string[];
  };
}

export type Route = 'NEEDS_SD_REVIEW' | 'READY_FOR_BEDROCK_REVIEW';

export interface RoutingReason {
  code: 'INVALID_INPUT' | 'MISSING_REQUIRED_INFORMATION'
    | 'AMBIGUITY' | 'CONTRADICTION' | 'CLINICAL_SAFETY_CONCERN'
    | 'SCREENING_NOT_ASSESSED' | 'READY_FOR_AI_REVIEW';
  field: string;
  message: string;
}

export interface RoutingResult {
  /** Null means no valid identifier was provided; the router never invents one. */
  requestId: string | null;
  route: Route;
  reasons: RoutingReason[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Pure, deterministic pre-screening for ordinary JSON input. Neither route is
 * clinical approval, build authorization, or permission to release software.
 * Unknown/malformed screening information fails closed to SD review.
 * Free-text ambiguity and semantic contradictions require upstream human checks.
 */
export function routeDesignBrief(input: unknown): RoutingResult {
  const reasons: RoutingReason[] = [];
  const brief = isRecord(input) ? input : {};
  const requestId = isText(brief.requestId) ? brief.requestId : null;
  const add = (code: RoutingReason['code'], field: string, message: string) => {
    reasons.push({ code, field, message });
  };

  if (!isRecord(input)) {
    add('INVALID_INPUT', 'brief', 'A DesignBrief object is required.');
  }

  for (const field of ['requestId', 'title', 'objective', 'targetPopulation']) {
    if (!isText(brief[field])) {
      add('MISSING_REQUIRED_INFORMATION', field, 'A non-empty string is required.');
    }
  }

  if (brief.screeningStatus === undefined) {
    add('MISSING_REQUIRED_INFORMATION', 'screeningStatus', 'Explicit screening status is required.');
  } else if (brief.screeningStatus === 'NOT_ASSESSED') {
    add('SCREENING_NOT_ASSESSED', 'screeningStatus', 'Screening is incomplete; empty finding arrays do not establish completion.');
  } else if (brief.screeningStatus !== 'ASSESSED') {
    add('INVALID_INPUT', 'screeningStatus', 'Screening status must be NOT_ASSESSED or ASSESSED.');
  }

  if (!Array.isArray(brief.requirements) || brief.requirements.length === 0) {
    add('MISSING_REQUIRED_INFORMATION', 'requirements', 'At least one condition/action requirement is required.');
  } else {
    const actions = new Map<string, string>();
    // Array.from also exposes sparse entries as undefined, so they fail closed.
    for (const [index, requirement] of Array.from(brief.requirements).entries()) {
      const field = `requirements[${index}]`;
      if (!isRecord(requirement) || !isText(requirement.condition) || !isText(requirement.action)) {
        add('MISSING_REQUIRED_INFORMATION', field, 'A non-empty condition and action are required.');
        continue;
      }
      const condition = normalize(requirement.condition);
      const action = normalize(requirement.action);
      const previousAction = actions.get(condition);
      if (previousAction !== undefined && previousAction !== action) {
        add('CONTRADICTION', field, 'The same condition specifies different actions; a designer must clarify intent.');
      }
      actions.set(condition, action);
    }
  }

  if (!isRecord(brief.reviewFlags)) {
    add('MISSING_REQUIRED_INFORMATION', 'reviewFlags', 'Explicit screening findings are required.');
  } else {
    const flagCodes = {
      ambiguities: 'AMBIGUITY',
      contradictions: 'CONTRADICTION',
      clinicalSafetyConcerns: 'CLINICAL_SAFETY_CONCERN',
    } as const;
    for (const [flag, code] of Object.entries(flagCodes)) {
      const findings = brief.reviewFlags[flag];
      if (!Array.isArray(findings) || Array.from(findings).some(value => !isText(value))) {
        add('INVALID_INPUT', `reviewFlags.${flag}`, 'An array of non-empty finding strings is required; use [] for no reported findings.');
      } else {
        for (const finding of findings) {
          add(code, `reviewFlags.${flag}`, finding);
        }
      }
    }
  }

  if (reasons.length > 0) {
    return { requestId, route: 'NEEDS_SD_REVIEW', reasons };
  }
  return {
    requestId,
    route: 'READY_FOR_BEDROCK_REVIEW',
    reasons: [{
      code: 'READY_FOR_AI_REVIEW',
      field: 'brief',
      message: 'Screening is marked ASSESSED (not independently verified). Required information is present and no concerns were reported or detected by structural checks. AI review may proceed; human approvals are still required.',
    }],
  };
}
