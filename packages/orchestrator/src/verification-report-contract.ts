/**
 * R6 VerificationReport contract boundary (REPLACEABLE).
 *
 * R6 owns the authoritative schema, published as the package export
 *   `@cht-nocode/verification/schema`
 *   (= packages/verification/src/verification-report.schema.json), latest on the
 *   `verification` branch commit 1bb8b1b — schemaVersion "2.3.0".
 * That package is not merged into this standalone R2 branch yet (it does not
 * resolve from node_modules here), so this file keeps a small, clearly-labelled
 * MIRROR of R6's published schema plus an Ajv (draft 2020-12) validator. When the
 * integration branch merges, REPLACE the embedded schema with a direct import of
 * `@cht-nocode/verification/schema` and delete the copy — the official R6 schema
 * remains the single source of truth; this must not become a competing permanent
 * schema. The embedded JSON below is copied verbatim from R6's published v2.3.0
 * file; R2 does not reinterpret it, and a test validates parity against the
 * actual schema at commit 1bb8b1b.
 *
 * v2.3.0 adds (vs 2.2.0): required top-level `asOf` and `evaluator` provenance,
 * `references.expectedCompileArtifactHash`, and `coverage.coveredViaBlockedSubmission`
 * (plus optional per-case fields). v2.2.0's top-level `version` (alias of
 * `schemaVersion`) and `packageHash` (promoted from `references.packageHash`)
 * remain. R2 structurally enforces `version === schemaVersion` and top-level
 * `packageHash === references.packageHash`.
 *
 * R2 uses this only to (a) validate the entire fetched report against R6's
 * structure/version and (b) read the report's top-level gate fields and
 * echoed references for cross-checking against R2's authoritative identities.
 * R2 never computes verification outcomes.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

/** The schemaVersion R6 publishes (official verification branch @ 1bb8b1b). */
export const VERIFICATION_REPORT_SCHEMA_VERSION = '2.3.0' as const;

/** Verbatim mirror of R6's verification-report.schema.json (2.3.0). Replace on merge. */
export const verificationReportSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/cht-nocode/verification/verification-report.schema.json',
  title: 'VerificationReport',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'version', 'packageHash', 'generatedAt', 'asOf', 'evaluator', 'passed', 'coverageComplete', 'toolVersions', 'run', 'references',
    'compileArtifactHash', 'testedDirHash', 'patientSetHash', 'goldenCasesHash', 'integrityChecks',
    'coverage', 'cases', 'disagreements',
  ],
  properties: {
    schemaVersion: { const: VERIFICATION_REPORT_SCHEMA_VERSION },
    // Plain-string alias of schemaVersion (R7's verify stage reads a top-level
    // `version`). The R6 builder enforces version === schemaVersion.
    version: { const: VERIFICATION_REPORT_SCHEMA_VERSION },
    // Promoted from references.packageHash by the R6 builder; nullable.
    packageHash: { type: ['string', 'null'], minLength: 1 },
    generatedAt: { type: 'string', format: 'date-time' },
    // v2.3.0: run-as-of marker and evaluator provenance metadata.
    asOf: { type: 'string', minLength: 1 },
    evaluator: {
      type: 'object', additionalProperties: false,
      required: ['used', 'reason', 'source', 'root', 'evaluatorHash', 'pythonVersion', 'jsonschemaVersion', 'logicModelSource', 'asOf'],
      properties: {
        used: { type: 'boolean' },
        reason: { type: ['string', 'null'] },
        source: { enum: ['env', 'repo', 'vendored-zip-unpinned', null] },
        root: { type: ['string', 'null'] },
        evaluatorHash: { type: ['string', 'null'] },
        pythonVersion: { type: ['string', 'null'] },
        jsonschemaVersion: { type: ['string', 'null'] },
        logicModelSource: { enum: ['LOGIC_MODEL_FILE', '/in/logic.json', 'CHT_CONFIG_DIR', null] },
        asOf: { type: 'string', minLength: 1 },
      },
    },
    passed: { type: 'boolean' },
    coverageComplete: { type: 'boolean' },
    toolVersions: {
      type: 'object', additionalProperties: false,
      required: ['node', 'chtConf', 'chtConfTestHarness', 'chromiumRevision', 'python'],
      properties: {
        node: { type: 'string', minLength: 1 }, chtConf: { type: 'string', minLength: 1 },
        chtConfTestHarness: { type: 'string', minLength: 1 }, chromiumRevision: { type: 'string', minLength: 1 },
        python: { type: 'string', minLength: 1 },
      },
    },
    run: {
      type: 'object', additionalProperties: false, required: ['command', 'tz', 'seed', 'fixedClock'],
      properties: {
        command: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        tz: { type: 'string', minLength: 1 }, seed: { type: ['string', 'null'] }, fixedClock: { type: 'string', minLength: 1 },
      },
    },
    references: {
      type: 'object', additionalProperties: false,
      required: ['snapshotId', 'logicModelHash', 'revision', 'clinicalApprovalId', 'compilationJobId', 'packageHash', 'expectedCompileArtifactHash'],
      properties: {
        snapshotId: { type: ['string', 'null'], minLength: 1 },
        logicModelHash: { type: ['string', 'null'], minLength: 1 },
        revision: { type: ['string', 'null'], minLength: 1 },
        clinicalApprovalId: { type: ['string', 'null'], minLength: 1 },
        compilationJobId: { type: ['string', 'null'], minLength: 1 },
        packageHash: { type: ['string', 'null'], minLength: 1 },
        expectedCompileArtifactHash: { type: ['string', 'null'], minLength: 1 },
      },
    },
    compileArtifactHash: { $ref: '#/$defs/sha256' },
    testedDirHash: { $ref: '#/$defs/sha256' },
    patientSetHash: { $ref: '#/$defs/sha256' },
    goldenCasesHash: { oneOf: [{ $ref: '#/$defs/sha256' }, { type: 'null' }] },
    integrityChecks: { type: 'array', items: { $ref: '#/$defs/integrityCheck' } },
    coverage: {
      type: 'object', additionalProperties: false,
      required: ['method', 'branchSource', 'sampleWarning', 'totalBranches', 'coveredBranches', 'coveredBranchIds', 'coveredViaBlockedSubmission', 'uncoveredBranchIds', 'uncoveredBranches'],
      properties: {
        method: { const: 'observed-outcome' },
        branchSource: { enum: ['manifest', 'sample'] },
        sampleWarning: { type: ['string', 'null'], minLength: 1 },
        totalBranches: { type: 'integer', minimum: 0 },
        coveredBranches: { type: 'integer', minimum: 0 },
        coveredBranchIds: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        coveredViaBlockedSubmission: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        uncoveredBranchIds: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        uncoveredBranches: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['id', 'reason'],
            properties: { id: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 } } },
        },
      },
    },
    cases: { type: 'array', items: { $ref: '#/$defs/case' } },
    disagreements: { type: 'array', items: { $ref: '#/$defs/disagreement' } },
  },
  $defs: {
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    integrityCheck: {
      type: 'object', additionalProperties: false, required: ['name', 'ok', 'detail'],
      properties: { name: { type: 'string', minLength: 1 }, ok: { type: 'boolean' }, detail: { type: 'string' } },
    },
    expectedResult: {
      type: ['object', 'null'], additionalProperties: false, required: ['expected', 'status'],
      properties: { expected: {}, status: { enum: ['pass', 'fail'] } },
    },
    case: {
      type: 'object', additionalProperties: false,
      required: ['id', 'input', 'branchId', 'kind', 'actual', 'golden', 'evaluator', 'status', 'failureDetail', 'harnessOutput'],
      properties: {
        id: { type: 'string', minLength: 1 }, input: {}, branchId: { type: ['string', 'null'] },
        kind: { enum: ['branch', 'boundary', 'exceptional'] }, actual: {},
        golden: { $ref: '#/$defs/expectedResult' }, evaluator: { $ref: '#/$defs/expectedResult' },
        status: { enum: ['pass', 'fail', 'disagree', 'error'] },
        // v2.3.0 optional case annotations.
        matchedBy: { enum: ['form-blocked-submission'] },
        blockedSubmission: { type: 'boolean' },
        expectedSource: { enum: ['evaluator', 'golden', 'both'] },
        matchedRows: { type: 'array', items: { type: 'integer', minimum: 0 } },
        comparedFields: { type: 'array', items: { type: 'string' } },
        failureDetail: { type: ['string', 'null'] }, harnessOutput: { type: ['string', 'null'] },
      },
    },
    disagreement: {
      type: 'object', additionalProperties: false, required: ['caseId', 'kind', 'actual', 'golden', 'evaluator', 'detail'],
      properties: {
        caseId: { type: 'string', minLength: 1 },
        kind: { enum: ['golden-vs-evaluator', 'actual-vs-golden', 'actual-vs-evaluator'] },
        actual: {}, golden: {}, evaluator: {}, detail: { type: 'string' },
      },
    },
  },
} as const;

/** Evaluator provenance echoed by R6 (v2.3.0). R2 records it, never fabricates it. */
export interface VerificationEvaluatorView {
  used: boolean;
  reason: string | null;
  source: 'env' | 'repo' | 'vendored-zip-unpinned' | null;
  root: string | null;
  evaluatorHash: string | null;
  pythonVersion: string | null;
  jsonschemaVersion: string | null;
  logicModelSource: 'LOGIC_MODEL_FILE' | '/in/logic.json' | 'CHT_CONFIG_DIR' | null;
  asOf: string;
}

/** The subset of the report R2 reads once the whole document is schema-valid. */
export interface VerificationReportView {
  schemaVersion: string;
  /** Plain-string alias of schemaVersion; v2.2.0 top-level field. */
  version: string;
  /** Top-level packageHash (v2.2.0); promoted from references.packageHash. */
  packageHash: string | null;
  /** Run-as-of marker (v2.3.0). */
  asOf: string;
  /** Evaluator provenance metadata (v2.3.0). */
  evaluator: VerificationEvaluatorView;
  passed: boolean;
  coverageComplete: boolean;
  compileArtifactHash: string;
  testedDirHash: string;
  goldenCasesHash: string | null;
  references: {
    snapshotId: string | null;
    logicModelHash: string | null;
    revision: string | null;
    clinicalApprovalId: string | null;
    compilationJobId: string | null;
    packageHash: string | null;
    /** v2.3.0: the compile-artifact hash R6 expected to verify. */
    expectedCompileArtifactHash: string | null;
  };
}

// Ajv with the ajv-formats "date-time" check omitted deliberately: R2 does not
// take a new dependency just to range-check a timestamp R6 already produces.
// The `format` keyword is non-assertive by default in Ajv, so this is safe.
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const compiled: ValidateFunction = ajv.compile(verificationReportSchema);

export interface ReportValidation {
  ok: boolean;
  report: VerificationReportView | null;
  errors: string[];
}

/** Validate a parsed report against R6's v2.3.0 schema and extract the view. */
export function validateVerificationReport(value: unknown): ReportValidation {
  if (!compiled(value)) {
    return { ok: false, report: null, errors: (compiled.errors ?? []).map(e => `${e.instancePath} ${e.message}`.trim()) };
  }
  const v = value as Record<string, unknown>;
  const refs = v.references as Record<string, unknown>;
  const evaluator = v.evaluator as Record<string, unknown>;
  // Structural cross-checks the schema alone cannot express (both consts are
  // "2.3.0" so Ajv already pins them, but assert the aliasing invariant R6's
  // builder guarantees, and that the promoted top-level packageHash agrees with
  // references.packageHash). These are integrity checks, not clinical outcomes.
  const topPackageHash = (v.packageHash as string | null) ?? null;
  const refPackageHash = (refs.packageHash as string | null) ?? null;
  if (v.version !== v.schemaVersion) {
    return { ok: false, report: null, errors: ['/version must equal /schemaVersion'] };
  }
  if (topPackageHash !== refPackageHash) {
    return { ok: false, report: null, errors: ['/packageHash must equal /references/packageHash'] };
  }
  const report: VerificationReportView = {
    schemaVersion: v.schemaVersion as string,
    version: v.version as string,
    packageHash: topPackageHash,
    asOf: v.asOf as string,
    evaluator: {
      used: evaluator.used as boolean,
      reason: (evaluator.reason as string | null) ?? null,
      source: (evaluator.source as VerificationEvaluatorView['source']) ?? null,
      root: (evaluator.root as string | null) ?? null,
      evaluatorHash: (evaluator.evaluatorHash as string | null) ?? null,
      pythonVersion: (evaluator.pythonVersion as string | null) ?? null,
      jsonschemaVersion: (evaluator.jsonschemaVersion as string | null) ?? null,
      logicModelSource: (evaluator.logicModelSource as VerificationEvaluatorView['logicModelSource']) ?? null,
      asOf: evaluator.asOf as string,
    },
    passed: v.passed as boolean,
    coverageComplete: v.coverageComplete as boolean,
    compileArtifactHash: v.compileArtifactHash as string,
    testedDirHash: v.testedDirHash as string,
    goldenCasesHash: (v.goldenCasesHash as string | null) ?? null,
    references: {
      snapshotId: (refs.snapshotId as string | null) ?? null,
      logicModelHash: (refs.logicModelHash as string | null) ?? null,
      revision: (refs.revision as string | null) ?? null,
      clinicalApprovalId: (refs.clinicalApprovalId as string | null) ?? null,
      compilationJobId: (refs.compilationJobId as string | null) ?? null,
      packageHash: refPackageHash,
      expectedCompileArtifactHash: (refs.expectedCompileArtifactHash as string | null) ?? null,
    },
  };
  return { ok: true, report, errors: [] };
}
