/**
 * Assembles a VerificationReport from executed cases and expected-outcome
 * sources. The builder computes `passed`, every case `status`, and every
 * source's pass/fail itself. A model never judges a case; expected values come
 * only from golden cases and the evaluator.
 *
 * Builder independence (Task 5 E): a source NEVER tells the builder whether it
 * passed. Each source supplies only an `expected` map (and optionally the field
 * names it cares about). The builder compares `actual` with `expected` using
 * jsonEqual, restricted to the comparison fields = manifest outputFields plus
 * any fields the source names. Any precomputed status handed in is ignored.
 */
import type {
  Coverage,
  Disagreement,
  EvaluatorInfo,
  ExpectedResult,
  IntegrityCheck,
  JsonValue,
  References,
  RunInfo,
  ToolVersions,
  VerificationCase,
  VerificationReport,
} from './report.js';
import { VERIFICATION_REPORT_SCHEMA_VERSION } from './report.js';

/**
 * What a source (golden case or evaluator) asserts for one case: the expected
 * output-field values. `fields` optionally extends the comparison beyond the
 * manifest's output fields. There is deliberately NO status here; the builder
 * decides pass/fail.
 */
export interface SourceExpectation {
  expected: Record<string, JsonValue>;
  /** Extra field names to compare, on top of the manifest output fields. */
  fields?: string[];
}

/** A case after execution, before the builder derives verdicts and status. */
export interface ExecutedCase {
  id: string;
  input: JsonValue;
  branchId: string | null;
  kind: VerificationCase['kind'];
  actual: Record<string, JsonValue> | null;
  harnessOutput: string | null;
  /** True when submission was blocked by a required-but-unanswered question. */
  blockedSubmission?: boolean;
  /** Source expectations, if provided. The builder derives pass/fail from these. */
  golden: SourceExpectation | null;
  evaluator: SourceExpectation | null;
  /** Evaluator error message (ok:false from the bridge); makes the case 'error'. */
  evaluatorError?: string | null;
  /** Decision-table rows the evaluator matched, for disclosure. */
  matchedRows?: number[];
}

/** Deep-equal for JSON values (stable, order-sensitive for arrays). */
function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The field names to compare for one source: manifest output fields unioned
 * with any fields the source names, in a stable (sorted) order.
 */
/**
 * The fields a source declares: its explicit `fields` list if present,
 * otherwise the keys of its `expected` object. Only these are compared.
 */
export function declaredFields(source: SourceExpectation): string[] {
  return [...new Set(source.fields ?? Object.keys(source.expected))].sort();
}

/**
 * Compare actual with a source over ONLY the fields the source declares
 * (Correction A):
 *   - a declared field missing from actual is a fail;
 *   - a declared field whose values differ is a fail;
 *   - a field present in actual but not declared is neither compared nor a
 *     fail.
 * Returns a builder-derived ExpectedResult; any status the source carried is
 * ignored. `outputFields` is no longer part of the comparison basis.
 */
export function evaluateSource(
  actual: Record<string, JsonValue> | null,
  source: SourceExpectation,
): ExpectedResult {
  const fields = declaredFields(source);
  // Record what the source expected over its declared fields.
  const recordedExpected: Record<string, JsonValue> = {};
  for (const f of fields) if (f in source.expected) recordedExpected[f] = source.expected[f]!;

  if (actual === null) return { expected: recordedExpected, status: 'fail' };

  let status: ExpectedResult['status'] = 'pass';
  for (const f of fields) {
    if (!(f in actual)) {
      status = 'fail'; // declared but missing from actual
      break;
    }
    if (!jsonEqual(source.expected[f]!, actual[f]!)) {
      status = 'fail';
      break;
    }
  }
  return { expected: recordedExpected, status };
}

interface DerivedCase {
  golden: ExpectedResult | null;
  evaluator: ExpectedResult | null;
  status: VerificationCase['status'];
  detail: string | null;
  /** How a pass was reached, when not the ordinary outcome match. */
  matchedBy?: 'form-blocked-submission';
  /** Which source(s) backed the case. */
  expectedSource?: 'evaluator' | 'golden' | 'both';
  /** Intersection of golden/evaluator declared fields (K1); set when both exist. */
  comparedFields?: string[];
}

/** Which source(s) a case has expectations from. */
function sourceLabel(c: ExecutedCase): 'evaluator' | 'golden' | 'both' | undefined {
  const hasG = c.golden !== null;
  const hasE = c.evaluator !== null || !!c.evaluatorError;
  if (hasG && hasE) return 'both';
  if (hasG) return 'golden';
  if (hasE) return 'evaluator';
  return undefined;
}

/**
 * Derive one case's verdicts and status. Status order is strict:
 * error > disagree > fail > pass. A case can only be 'pass' if at least one
 * source is present and every present source passed.
 *
 * `classificationField` is the name of the classification output field. A
 * present source that does NOT declare it cannot meaningfully verify the case,
 * so the case status is 'error' (Correction A).
 */
export function deriveCase(c: ExecutedCase, classificationField: string): DerivedCase {
  const expectedSource = sourceLabel(c);
  const d = deriveCaseCore(c, classificationField);
  let out = expectedSource ? { ...d, expectedSource } : d;
  // K1: record the compared intersection when both sources are present
  // (unless deriveCaseCore already set it on a disagree).
  if (c.golden && c.evaluator && out.comparedFields === undefined) {
    const shared = declaredFields(c.golden).filter((f) => declaredFields(c.evaluator!).includes(f));
    out = { ...out, comparedFields: shared };
  }
  return out;
}

function deriveCaseCore(c: ExecutedCase, classificationField: string): DerivedCase {
  const golden = c.golden ? evaluateSource(c.actual, c.golden) : null;
  const evaluator = c.evaluator ? evaluateSource(c.actual, c.evaluator) : null;

  // E4: an evaluator error (ok:false from the bridge) makes the case 'error'
  // with the evaluator's message, regardless of anything else.
  if (c.evaluatorError) {
    return { golden, evaluator, status: 'error', detail: `evaluator error: ${c.evaluatorError}` };
  }

  // J2: a form that refused to submit because a required visible question was
  // unanswered is a legitimate "incomplete" outcome. The harness produced no
  // actual, so compare against what the sources EXPECT for classification:
  //   - a source expecting "incomplete"  -> pass (matchedBy form-blocked-submission)
  //   - a source expecting anything else -> fail
  //   - no source                        -> error
  if (c.blockedSubmission) {
    const sources: Array<{ name: string; src: SourceExpectation }> = [];
    if (c.golden) sources.push({ name: 'golden', src: c.golden });
    if (c.evaluator) sources.push({ name: 'evaluator', src: c.evaluator });
    if (sources.length === 0) {
      return { golden, evaluator, status: 'error', detail: 'form blocked submission (required question unanswered); no source to compare' };
    }
    const mismatched = sources.filter((s) => s.src.expected[classificationField] !== 'incomplete');
    if (mismatched.length > 0) {
      return {
        golden,
        evaluator,
        status: 'fail',
        detail: `form blocked submission, but ${mismatched.map((s) => s.name).join(' and ')} expected ${classificationField} != "incomplete"`,
      };
    }
    return {
      golden,
      evaluator,
      status: 'pass',
      detail: 'form blocked submission (required question unanswered) and the source expected "incomplete"',
      matchedBy: 'form-blocked-submission',
    };
  }

  if (c.actual === null) {
    return { golden, evaluator, status: 'error', detail: 'no actual outcome recorded' };
  }
  if (!golden && !evaluator) {
    return { golden, evaluator, status: 'error', detail: 'no expected-outcome source (golden or evaluator) available' };
  }
  // A present source must declare the classification field.
  const undeclared: string[] = [];
  if (c.golden && !declaredFields(c.golden).includes(classificationField)) undeclared.push('golden');
  if (c.evaluator && !declaredFields(c.evaluator).includes(classificationField)) undeclared.push('evaluator');
  if (undeclared.length > 0) {
    return {
      golden,
      evaluator,
      status: 'error',
      detail: `${undeclared.join(' and ')} did not declare the "${classificationField}" field`,
    };
  }
  // K1: golden vs evaluator disagree only on the INTERSECTION of the fields
  // both sources declare, compared strictly. A field only one source declares
  // is not a disagreement (it is still compared to actual by that source). An
  // empty intersection never disagrees.
  if (c.golden && c.evaluator) {
    const shared = declaredFields(c.golden).filter((f) => declaredFields(c.evaluator!).includes(f));
    const differing = shared.filter((f) => !jsonEqual(c.golden!.expected[f] ?? null, c.evaluator!.expected[f] ?? null));
    if (differing.length > 0) {
      const detail =
        'golden and evaluator disagree on ' +
        differing
          .map((f) => `${f} (golden=${JSON.stringify(c.golden!.expected[f] ?? null)}, evaluator=${JSON.stringify(c.evaluator!.expected[f] ?? null)})`)
          .join('; ');
      return { golden, evaluator, status: 'disagree', detail, comparedFields: shared };
    }
  }
  const failed: string[] = [];
  if (golden && golden.status === 'fail') failed.push('golden');
  if (evaluator && evaluator.status === 'fail') failed.push('evaluator');
  if (failed.length > 0) {
    return { golden, evaluator, status: 'fail', detail: `actual differs from ${failed.join(' and ')}` };
  }
  return { golden, evaluator, status: 'pass', detail: null };
}

/** Disagreements: one per failed source comparison, plus golden-vs-evaluator. */
export function buildDisagreements(
  cases: ExecutedCase[],
  classificationField: string,
): Disagreement[] {
  const out: Disagreement[] = [];
  for (const c of cases) {
    const actual: JsonValue | null = c.actual as JsonValue | null;
    const derived = deriveCase(c, classificationField);
    if (derived.golden && derived.golden.status === 'fail') {
      out.push({
        caseId: c.id,
        kind: 'actual-vs-golden',
        actual,
        golden: derived.golden.expected,
        evaluator: derived.evaluator ? derived.evaluator.expected : null,
        detail: 'actual differs from golden expected',
      });
    }
    if (derived.evaluator && derived.evaluator.status === 'fail') {
      out.push({
        caseId: c.id,
        kind: 'actual-vs-evaluator',
        actual,
        golden: derived.golden ? derived.golden.expected : null,
        evaluator: derived.evaluator.expected,
        detail: 'actual differs from evaluator expected',
      });
    }
    if (derived.golden && derived.evaluator && !jsonEqual(derived.golden.expected, derived.evaluator.expected)) {
      out.push({
        caseId: c.id,
        kind: 'golden-vs-evaluator',
        actual,
        golden: derived.golden.expected,
        evaluator: derived.evaluator.expected,
        detail: 'golden and evaluator expected values differ',
      });
    }
  }
  return out;
}

export interface BuildReportArgs {
  generatedAt: string;
  /** Fixed clock / as-of date (YYYY-MM-DD). */
  asOf: string;
  /** Evaluator facts for the report (F2). */
  evaluator: EvaluatorInfo;
  toolVersions: ToolVersions;
  run: RunInfo;
  references: References;
  compileArtifactHash: string;
  testedDirHash: string;
  patientSetHash: string;
  goldenCasesHash: string | null;
  coverage: Coverage;
  /**
   * Name of the classification output field. A source that doesn't declare it
   * makes the case status 'error'. (Sources are otherwise compared only over
   * the fields they declare; see evaluateSource.)
   */
  classificationField: string;
  /** Which case ids used the page-count fallback (option B). */
  pageFallbackCaseIds: string[];
  /** Integrity checks other than pageFallbacks (e.g. compileArtifactHash). */
  integrityChecks: IntegrityCheck[];
  cases: ExecutedCase[];
}

/**
 * Build the full report and compute `passed`. `passed` is false if cases is
 * empty, any case is fail/disagree/error, coverage is incomplete, or any
 * integrity check is not ok. Never set by hand.
 */
export function buildReport(args: BuildReportArgs): VerificationReport {
  const cases: VerificationCase[] = args.cases.map((c) => {
    const derived = deriveCase(c, args.classificationField);
    return {
      id: c.id,
      input: c.input,
      branchId: c.branchId,
      kind: c.kind,
      actual: c.actual as JsonValue | null,
      golden: derived.golden,
      evaluator: derived.evaluator,
      status: derived.status,
      ...(derived.matchedBy ? { matchedBy: derived.matchedBy } : {}),
      ...(c.blockedSubmission ? { blockedSubmission: true } : {}),
      ...(derived.expectedSource ? { expectedSource: derived.expectedSource } : {}),
      ...(c.matchedRows ? { matchedRows: c.matchedRows } : {}),
      ...(derived.comparedFields ? { comparedFields: derived.comparedFields } : {}),
      failureDetail: derived.detail,
      harnessOutput: c.harnessOutput,
    };
  });

  const nFallbacks = args.pageFallbackCaseIds.length;
  const nCases = args.cases.length;
  const pageFallbacks: IntegrityCheck = {
    name: 'pageFallbacks',
    ok: true, // a hidden-page fallback is not a failure by itself
    detail:
      nFallbacks === 0
        ? `0 of ${nCases} cases used the hidden-page fallback`
        : `${nFallbacks} of ${nCases} cases used the hidden-page fallback: ${args.pageFallbackCaseIds.join(', ')}`,
  };
  const integrityChecks = [...args.integrityChecks, pageFallbacks];

  // coverageComplete is false if the branch set came from sample data, if the
  // required set is empty, or if any branch is uncovered.
  const coverageComplete =
    args.coverage.branchSource !== 'sample' &&
    args.coverage.totalBranches > 0 &&
    args.coverage.uncoveredBranchIds.length === 0;
  const anyBadCase = cases.some((c) => c.status !== 'pass');
  const anyIntegrityFail = integrityChecks.some((c) => !c.ok);
  const passed = cases.length > 0 && !anyBadCase && coverageComplete && !anyIntegrityFail;

  return {
    schemaVersion: VERIFICATION_REPORT_SCHEMA_VERSION,
    // Top-level mirrors for R7's verify stage; kept in lock-step here so they
    // can never drift from their canonical source.
    version: VERIFICATION_REPORT_SCHEMA_VERSION,
    packageHash: args.references.packageHash,
    generatedAt: args.generatedAt,
    asOf: args.asOf,
    evaluator: args.evaluator,
    passed,
    coverageComplete,
    toolVersions: args.toolVersions,
    run: args.run,
    references: args.references,
    compileArtifactHash: args.compileArtifactHash,
    testedDirHash: args.testedDirHash,
    patientSetHash: args.patientSetHash,
    goldenCasesHash: args.goldenCasesHash,
    integrityChecks,
    coverage: args.coverage,
    cases,
    disagreements: buildDisagreements(args.cases, args.classificationField),
  };
}
