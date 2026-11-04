/**
 * TEST ONLY. Builds FICTIONAL VerificationReport documents matching R6's
 * published v2.3.0 schema shape (official verification branch @ 1bb8b1b), so
 * R2's ingestion can be exercised without R6. These are clearly simulated
 * teammate outputs, NOT real R6 verification runs.
 *
 * v2.3.0 vs 2.2.0: adds required top-level `asOf` and `evaluator` provenance,
 * `references.expectedCompileArtifactHash`, and `coverage.coveredViaBlockedSubmission`.
 * v2.2.0's top-level `version` (alias of `schemaVersion`) and `packageHash`
 * (promoted from `references.packageHash`) remain. By default this fixture keeps
 * them consistent; overrides below let negative tests diverge/omit them.
 */
import { VERIFICATION_REPORT_SCHEMA_VERSION } from '../../src/verification-report-contract.ts';

const HASH = (d: string) => d.repeat(64);

export interface ReportOverrides {
  passed?: boolean;
  coverageComplete?: boolean;
  compileArtifactHash?: string;
  testedDirHash?: string;
  goldenCasesHash?: string | null;
  references?: Partial<{
    snapshotId: string | null; logicModelHash: string | null; revision: string | null;
    clinicalApprovalId: string | null; compilationJobId: string | null; packageHash: string | null;
    expectedCompileArtifactHash: string | null;
  }>;
  /** Override individual evaluator fields (defaults to a valid, used evaluator). */
  evaluator?: Partial<{
    used: boolean; reason: string | null;
    source: 'env' | 'repo' | 'vendored-zip-unpinned' | null; root: string | null;
    evaluatorHash: string | null; pythonVersion: string | null; jsonschemaVersion: string | null;
    logicModelSource: 'LOGIC_MODEL_FILE' | '/in/logic.json' | 'CHT_CONFIG_DIR' | null; asOf: string;
  }>;
  /** Override the top-level `asOf` marker independently. */
  asOf?: string;
  schemaVersion?: string;
  /** Override the top-level `version` alias independently (defaults to schemaVersion). */
  version?: string;
  /** Override the top-level `packageHash` independently (defaults to references.packageHash). */
  packageHash?: string | null;
  /** Omit a required top-level field entirely, to prove schema rejection. */
  omit?: 'version' | 'packageHash' | 'asOf' | 'evaluator';
}

/** A schema-valid, passing v2.3.0 VerificationReport. Override to make it fail/mismatch. */
export function fictionalReport(over: ReportOverrides = {}): Record<string, unknown> {
  const passed = over.passed ?? true;
  const schemaVersion = over.schemaVersion ?? VERIFICATION_REPORT_SCHEMA_VERSION;
  const compileArtifactHash = over.compileArtifactHash ?? HASH('e');
  const references = {
    snapshotId: 'snap-1', logicModelHash: HASH('b'), revision: '1', clinicalApprovalId: 'clin-1',
    compilationJobId: 'compile-x', packageHash: HASH('c'), expectedCompileArtifactHash: compileArtifactHash,
    ...over.references,
  };
  const evaluator = {
    used: true, reason: null, source: 'repo' as const, root: '/opt/evaluator',
    evaluatorHash: HASH('a'), pythonVersion: 'Python 3.12.16', jsonschemaVersion: '4.23.0',
    logicModelSource: 'LOGIC_MODEL_FILE' as const, asOf: '2026-11-04',
    ...over.evaluator,
  };
  const report: Record<string, unknown> = {
    schemaVersion,
    version: over.version ?? schemaVersion,
    // Top-level packageHash tracks references.packageHash unless overridden.
    packageHash: over.packageHash !== undefined ? over.packageHash : references.packageHash,
    generatedAt: '2026-11-04T00:00:00.000Z',
    asOf: over.asOf ?? '2026-11-04',
    evaluator,
    passed,
    coverageComplete: over.coverageComplete ?? true,
    toolVersions: { node: 'v24.22.1', chtConf: '6.6.1', chtConfTestHarness: '1.0.0', chromiumRevision: '901912', python: 'Python 3.12.16' },
    run: { command: ['cht-conf-test-harness'], tz: 'Africa/Nairobi', seed: null, fixedClock: '2026-11-04' },
    references,
    compileArtifactHash,
    testedDirHash: over.testedDirHash ?? HASH('9'),
    patientSetHash: HASH('7'),
    goldenCasesHash: over.goldenCasesHash === undefined ? HASH('8') : over.goldenCasesHash,
    integrityChecks: [{ name: 'compileArtifactHash', ok: true, detail: 'matches' }],
    coverage: {
      method: 'observed-outcome', branchSource: 'manifest', sampleWarning: null,
      totalBranches: 2, coveredBranches: passed ? 2 : 1,
      coveredBranchIds: passed ? ['b1', 'b2'] : ['b1'],
      coveredViaBlockedSubmission: [],
      uncoveredBranchIds: passed ? [] : ['b2'],
      uncoveredBranches: passed ? [] : [{ id: 'b2', reason: 'no case produced this branch' }],
    },
    cases: [{ id: 'c1', input: {}, branchId: 'b1', kind: 'branch', actual: {}, golden: { expected: {}, status: 'pass' }, evaluator: null, status: 'pass', failureDetail: null, harnessOutput: null }],
    disagreements: [],
  };
  if (over.omit) delete report[over.omit];
  return report;
}
