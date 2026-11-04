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
  /** Source expectations, if provided. The builder derives pass/fail from these. */
  golden: SourceExpectation | null;
  evaluator: SourceExpectation | null;
}

/** Deep-equal for JSON values (stable, order-sensitive for arrays). */
function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The field names to compare for one source: manifest output fields unioned
 * with any fields the source names, in a stable (sorted) order.
 */
function comparisonFields(outputFields: readonly string[], source: SourceExpectation): string[] {
  return [...new Set([...outputFields, ...(source.fields ?? [])])].sort();
}

/**
 * Compare actual with a source's expected over the comparison fields. A field
 * the source expects but actual lacks (or vice versa) is a mismatch. Returns a
 * builder-derived ExpectedResult; the source's own status (if any) is ignored.
 */
export function evaluateSource(
  actual: Record<string, JsonValue> | null,
  source: SourceExpectation,
  outputFields: readonly string[],
): ExpectedResult {
  const fields = comparisonFields(outputFields, source);
  // The report records what the source expected over the compared fields.
  const recordedExpected: Record<string, JsonValue> = {};
  for (const f of fields) if (f in source.expected) recordedExpected[f] = source.expected[f]!;

  if (actual === null) return { expected: recordedExpected, status: 'fail' };

  let status: ExpectedResult['status'] = 'pass';
  for (const f of fields) {
    const inExpected = f in source.expected;
    const inActual = f in actual;
    // A field present on one side but not the other is a mismatch.
    if (inExpected !== inActual) {
      status = 'fail';
      break;
    }
    if (inExpected && inActual && !jsonEqual(source.expected[f]!, actual[f]!)) {
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
}

/**
 * Derive one case's verdicts and status. Status order is strict:
 * error > disagree > fail > pass. A case can only be 'pass' if at least one
 * source is present and every present source passed.
 */
export function deriveCase(c: ExecutedCase, outputFields: readonly string[]): DerivedCase {
  const golden = c.golden ? evaluateSource(c.actual, c.golden, outputFields) : null;
  const evaluator = c.evaluator ? evaluateSource(c.actual, c.evaluator, outputFields) : null;

  if (c.actual === null) {
    return { golden, evaluator, status: 'error', detail: 'no actual outcome recorded' };
  }
  if (!golden && !evaluator) {
    return { golden, evaluator, status: 'error', detail: 'no expected-outcome source (golden or evaluator) available' };
  }
  if (golden && evaluator && !jsonEqual(golden.expected, evaluator.expected)) {
    return { golden, evaluator, status: 'disagree', detail: 'golden and evaluator expected values differ' };
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
  outputFields: readonly string[],
): Disagreement[] {
  const out: Disagreement[] = [];
  for (const c of cases) {
    const actual: JsonValue | null = c.actual as JsonValue | null;
    const derived = deriveCase(c, outputFields);
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
  toolVersions: ToolVersions;
  run: RunInfo;
  references: References;
  compileArtifactHash: string;
  testedDirHash: string;
  patientSetHash: string;
  goldenCasesHash: string | null;
  coverage: Coverage;
  /** Output field names from the manifest; the comparison basis for sources. */
  outputFields: readonly string[];
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
    const derived = deriveCase(c, args.outputFields);
    return {
      id: c.id,
      input: c.input,
      branchId: c.branchId,
      kind: c.kind,
      actual: c.actual as JsonValue | null,
      golden: derived.golden,
      evaluator: derived.evaluator,
      status: derived.status,
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
    generatedAt: args.generatedAt,
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
    disagreements: buildDisagreements(args.cases, args.outputFields),
  };
}
