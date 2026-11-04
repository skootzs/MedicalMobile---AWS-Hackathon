/**
 * VerificationReport: the output of one synthetic-patient verification run
 * against one built CHT configuration directory.
 *
 * Kept in sync by hand with ./verification-report.schema.json.
 * Any change here must be mirrored there.
 * Rule: bump schemaVersion on any breaking schema change.
 *
 * This file only defines shapes. It computes nothing and holds no
 * expected clinical outcomes.
 *
 * Runner exit codes (the runner always tries to write report.json first):
 *   0 - passed: a valid report.json was written and report.passed is true.
 *   1 - verification failed: a valid report.json was written and
 *       report.passed is false (failed cases, disagreements, errors,
 *       incomplete coverage, empty cases, or a failed integrity check).
 *   2 - runner error: no valid report.json could be produced (for example
 *       python too old, missing inputs, or the harness could not start).
 */

export const VERIFICATION_REPORT_SCHEMA_VERSION = '2.0.0';

/** Any JSON-serialisable value. Used where the shape belongs to a teammate. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Why a case exists. Mirrors the draft PatientInput.kind in packages/synth
 * (Stage 3). Reconcile both when the evaluator's input type is known.
 */
export type CaseKind = 'branch' | 'boundary' | 'exceptional';

/**
 * Overall status of one case, derived by the report builder from `actual`
 * against BOTH expected-outcome results. Never set by hand.
 *
 * Derivation order:
 * 1. error    - the run errored (`actual` is null), or neither `golden` nor
 *               `evaluator` is present (no expected outcome to compare to).
 * 2. disagree - both are present and their `expected` values differ, so there
 *               is no single expected value. Shown to the reviewer; never
 *               resolved here.
 * 3. fail     - any present result has status 'fail'.
 * 4. pass     - every present result has status 'pass'.
 */
export type CaseStatus = 'pass' | 'fail' | 'disagree' | 'error';

/** Outcome of comparing `actual` against one expected-outcome source. */
export type ResultStatus = 'pass' | 'fail';

/**
 * One expected-outcome source's verdict for a case.
 * - golden: a golden case supplied by the team and confirmed by Medic.
 * - evaluator: the teammate's deterministic evaluator over approved logic.
 * Never a model, never this package.
 */
export interface ExpectedResult {
  expected: JsonValue;
  status: ResultStatus;
}

export interface ToolVersions {
  /** process.version, e.g. "v24.22.1". */
  node: string;
  /** cht-conf version used for the build being verified. */
  chtConf: string;
  /** cht-conf-test-harness version that ran the cases. */
  chtConfTestHarness: string;
  /** Chromium revision the harness launched, e.g. "901912". */
  chromiumRevision: string;
  /** python3 version used for form conversion; must be 3.10 or later. */
  python: string;
}

export interface Coverage {
  totalBranches: number;
  coveredBranches: number;
  uncoveredBranchIds: string[];
}

/**
 * Identifiers supplied by the orchestrator and echoed into the report for
 * traceability. All nullable. The runner does NOT verify any of these against
 * anything; it only records what it was given. (EXPECTED_SNAPSHOT_HASH, when
 * set, is checked separately and surfaces as an integrityCheck, not here.)
 */
export interface References {
  /** Approved logic snapshot the config was built from. */
  snapshotId: string | null;
  /** Hash of the approved logic model, from the orchestrator. */
  logicModelHash: string | null;
  /** Source revision (e.g. git sha) the build came from. */
  revision: string | null;
  /** Clinical approval record this build was approved under. */
  clinicalApprovalId: string | null;
  /** Compilation job that produced the tested directory. */
  compilationJobId: string | null;
  /** Package hash from the orchestrator. Echoed only, never verified. */
  packageHash: string | null;
}

/**
 * A deterministic integrity check the runner ran against the tested build.
 * `ok` false on any check forces report.passed to false.
 */
export interface IntegrityCheck {
  /** Stable identifier, e.g. "compileArtifactHash" or "expectedSnapshotHash". */
  name: string;
  ok: boolean;
  /** What was checked and why it passed or failed. */
  detail: string;
}

/** How the run was invoked, so it can be reproduced. */
export interface RunInfo {
  /** The exact test command the runner executed, as an argv array. */
  command: string[];
  /** TZ the harness ran under, e.g. "Africa/Nairobi". */
  tz: string;
  /** Generator seed, if the patient set used one; null if fully enumerated. */
  seed: string | null;
}

export interface VerificationCase {
  id: string;
  /**
   * The synthetic patient input, as given to the harness mapping.
   * Typed as JSON until PatientInput is reconciled with the evaluator.
   */
  input: JsonValue;
  /** Branch the case targets; null for exceptional cases with no branch. */
  branchId: string | null;
  kind: CaseKind;
  /** Outcome observed from the built form/tasks; null if the run errored. */
  actual: JsonValue | null;
  /** Verdict against the golden case; null if no golden case covers this input. */
  golden: ExpectedResult | null;
  /** Verdict against the evaluator; null if the evaluator gave no outcome. */
  evaluator: ExpectedResult | null;
  /** Derived from actual vs both results; see CaseStatus. */
  status: CaseStatus;
  /** Human-readable reason for any non-pass status; null on pass. */
  failureDetail: string | null;
  /** Raw harness output kept as failure evidence; null if none was captured. */
  harnessOutput: string | null;
}

/**
 * Which two values disagree.
 * - golden-vs-evaluator: the two expected-outcome sources differ.
 * - actual-vs-golden:    the built config differs from the golden case.
 * - actual-vs-evaluator: the built config differs from the evaluator.
 */
export type DisagreementKind =
  | 'golden-vs-evaluator'
  | 'actual-vs-golden'
  | 'actual-vs-evaluator';

/**
 * A mismatch shown to the reviewer; never resolved here.
 *
 * The report builder records:
 * - one actual-vs-golden entry for every case whose golden result is 'fail';
 * - one actual-vs-evaluator entry for every case whose evaluator result is
 *   'fail' (so at most one entry per case per source);
 * - one golden-vs-evaluator entry for every case where both sources are
 *   present and their expected values differ.
 *
 * `actual`, `golden` and `evaluator` are always present so the reviewer sees
 * all three. Each is null when that value was not available for the case.
 * Note: JSON null is also a legal outcome value; `kind` says which two values
 * are being compared.
 */
export interface Disagreement {
  caseId: string;
  kind: DisagreementKind;
  actual: JsonValue | null;
  golden: JsonValue | null;
  evaluator: JsonValue | null;
  detail: string;
}

export interface VerificationReport {
  schemaVersion: typeof VERIFICATION_REPORT_SCHEMA_VERSION;
  /** ISO 8601 UTC timestamp. */
  generatedAt: string;
  /**
   * Overall gate result. Computed by the report builder, never set by hand.
   * False if ANY of the following hold:
   *   - cases is empty;
   *   - any case is fail, disagree or error;
   *   - coverageComplete is false;
   *   - any integrityChecks entry has ok false.
   */
  passed: boolean;
  /** True only if every branch has at least one case (no uncovered branch). */
  coverageComplete: boolean;
  toolVersions: ToolVersions;
  run: RunInfo;
  /** Orchestrator-supplied identifiers, echoed for traceability, not verified. */
  references: References;
  /**
   * Recomputed compiler artifactHash over the two generated files
   * (forms/app/<formId>.xlsx and .properties.json), using R5's algorithm:
   * lowercase hex sha256 of the sorted-by-path lines `path<TAB>fileSha256<LF>`
   * (trailing LF on every line), joined with no separator. Excludes the .xml.
   */
  compileArtifactHash: string;
  /**
   * Lowercase hex sha256 over the WHOLE tested directory, including the .xml.
   * Built from the sorted lines `path<TAB>fileSha256<LF>` for every file in
   * the directory (paths relative, forward slashes), joined with no separator.
   */
  testedDirHash: string;
  /** Lowercase hex sha256 of the synthetic patient set that was run. */
  patientSetHash: string;
  /**
   * Lowercase hex sha256 of the golden cases file that was used, or null when
   * no golden file was supplied. Never hash empty input as a stand-in.
   */
  goldenCasesHash: string | null;
  /** Deterministic integrity checks; any ok:false forces passed:false. */
  integrityChecks: IntegrityCheck[];
  coverage: Coverage;
  cases: VerificationCase[];
  disagreements: Disagreement[];
}
