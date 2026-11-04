/**
 * Assembles a VerificationReport from executed cases and expected-outcome
 * sources. Computes `passed` and every case `status`. A model never judges a
 * case; expected values come only from golden cases and the evaluator.
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

/** A case after execution, before status/verdicts are decided. */
export interface ExecutedCase {
  id: string;
  input: JsonValue;
  branchId: string | null;
  kind: VerificationCase['kind'];
  actual: Record<string, JsonValue> | null;
  harnessOutput: string | null;
  /** Expected verdicts, if a source provided them. Builder never fills these. */
  golden: ExpectedResult | null;
  evaluator: ExpectedResult | null;
}

/** Deep-equal for JSON values (stable, order-sensitive for arrays). */
function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Derive one case's status from `actual` and both verdicts. Order is strict:
 * error > disagree > fail > pass. A case can only be 'pass' if at least one
 * source is present and every present source passed.
 */
export function deriveStatus(c: ExecutedCase): { status: VerificationCase['status']; detail: string | null } {
  const hasGolden = c.golden !== null;
  const hasEvaluator = c.evaluator !== null;

  if (c.actual === null) return { status: 'error', detail: 'no actual outcome recorded' };
  if (!hasGolden && !hasEvaluator) {
    return { status: 'error', detail: 'no expected-outcome source (golden or evaluator) available' };
  }
  if (hasGolden && hasEvaluator && !jsonEqual(c.golden!.expected, c.evaluator!.expected)) {
    return { status: 'disagree', detail: 'golden and evaluator expected values differ' };
  }
  const failed: string[] = [];
  if (hasGolden && c.golden!.status === 'fail') failed.push('golden');
  if (hasEvaluator && c.evaluator!.status === 'fail') failed.push('evaluator');
  if (failed.length > 0) return { status: 'fail', detail: `actual differs from ${failed.join(' and ')}` };
  return { status: 'pass', detail: null };
}

/** Disagreements: one per failed source comparison, plus golden-vs-evaluator. */
export function buildDisagreements(cases: ExecutedCase[]): Disagreement[] {
  const out: Disagreement[] = [];
  for (const c of cases) {
    const actual: JsonValue | null = c.actual as JsonValue | null;
    if (c.golden && c.golden.status === 'fail') {
      out.push({ caseId: c.id, kind: 'actual-vs-golden', actual, golden: c.golden.expected, evaluator: c.evaluator ? c.evaluator.expected : null, detail: 'actual differs from golden expected' });
    }
    if (c.evaluator && c.evaluator.status === 'fail') {
      out.push({ caseId: c.id, kind: 'actual-vs-evaluator', actual, golden: c.golden ? c.golden.expected : null, evaluator: c.evaluator.expected, detail: 'actual differs from evaluator expected' });
    }
    if (c.golden && c.evaluator && !jsonEqual(c.golden.expected, c.evaluator.expected)) {
      out.push({ caseId: c.id, kind: 'golden-vs-evaluator', actual, golden: c.golden.expected, evaluator: c.evaluator.expected, detail: 'golden and evaluator expected values differ' });
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
    const { status, detail } = deriveStatus(c);
    return {
      id: c.id,
      input: c.input,
      branchId: c.branchId,
      kind: c.kind,
      actual: (c.actual as JsonValue | null),
      golden: c.golden,
      evaluator: c.evaluator,
      status,
      failureDetail: detail,
      harnessOutput: c.harnessOutput,
    };
  });

  const pageFallbacks: IntegrityCheck = {
    name: 'pageFallbacks',
    ok: true, // a fallback is not a failure by itself
    detail:
      args.pageFallbackCaseIds.length === 0
        ? 'no page-count fallbacks'
        : `page-count fallback used for: ${args.pageFallbackCaseIds.join(', ')}`,
  };
  const integrityChecks = [...args.integrityChecks, pageFallbacks];

  const coverageComplete = args.coverage.uncoveredBranchIds.length === 0;
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
    disagreements: buildDisagreements(args.cases),
  };
}
