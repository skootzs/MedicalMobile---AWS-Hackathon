/**
 * R6 VerificationReport contract boundary (REPLACEABLE).
 *
 * R6 owns the authoritative schema at
 *   packages/verification/src/verification-report.schema.json  (official team
 *   integration branch `integrate/compiler`, commit 99001e8) — schemaVersion
 *   "2.2.0".
 * That package is not merged into this standalone R2 branch yet, so this file
 * keeps a small, clearly-labelled MIRROR of R6's published schema plus an Ajv
 * (draft 2020-12) validator. When the integration branch merges, replace the
 * embedded schema with a direct import of R6's file and delete the copy — the
 * official R6 schema remains the single source of truth; this must not become a
 * competing permanent schema. The embedded JSON below is copied verbatim from
 * R6's published v2.2.0 file; R2 does not reinterpret it.
 *
 * v2.2.0 adds (vs 2.1.0): a required top-level `version` const "2.2.0" (a plain
 * string alias of `schemaVersion`, which R7's verify stage reads) and a required
 * top-level `packageHash` (nullable) that the builder promotes from
 * `references.packageHash`. R2 structurally enforces `version === schemaVersion`
 * and top-level `packageHash === references.packageHash`.
 *
 * R2 uses this only to (a) validate the entire fetched report against R6's
 * structure/version and (b) read the report's top-level gate fields and
 * echoed references for cross-checking against R2's authoritative identities.
 * R2 never computes verification outcomes.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

/** The schemaVersion R6 publishes (official integrate/compiler @ 99001e8). */
export const VERIFICATION_REPORT_SCHEMA_VERSION = '2.2.0' as const;

/** Verbatim mirror of R6's verification-report.schema.json (2.2.0). Replace on merge. */
export const verificationReportSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/cht-nocode/verification/verification-report.schema.json',
  title: 'VerificationReport',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'version', 'packageHash', 'generatedAt', 'passed', 'coverageComplete', 'toolVersions', 'run', 'references',
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
      required: ['snapshotId', 'logicModelHash', 'revision', 'clinicalApprovalId', 'compilationJobId', 'packageHash'],
      properties: {
        snapshotId: { type: ['string', 'null'], minLength: 1 },
        logicModelHash: { type: ['string', 'null'], minLength: 1 },
        revision: { type: ['string', 'null'], minLength: 1 },
        clinicalApprovalId: { type: ['string', 'null'], minLength: 1 },
        compilationJobId: { type: ['string', 'null'], minLength: 1 },
        packageHash: { type: ['string', 'null'], minLength: 1 },
      },
    },
    compileArtifactHash: { $ref: '#/$defs/sha256' },
    testedDirHash: { $ref: '#/$defs/sha256' },
    patientSetHash: { $ref: '#/$defs/sha256' },
    goldenCasesHash: { oneOf: [{ $ref: '#/$defs/sha256' }, { type: 'null' }] },
    integrityChecks: { type: 'array', items: { $ref: '#/$defs/integrityCheck' } },
    coverage: {
      type: 'object', additionalProperties: false,
      required: ['method', 'branchSource', 'sampleWarning', 'totalBranches', 'coveredBranches', 'coveredBranchIds', 'uncoveredBranchIds', 'uncoveredBranches'],
      properties: {
        method: { const: 'observed-outcome' },
        branchSource: { enum: ['manifest', 'sample'] },
        sampleWarning: { type: ['string', 'null'], minLength: 1 },
        totalBranches: { type: 'integer', minimum: 0 },
        coveredBranches: { type: 'integer', minimum: 0 },
        coveredBranchIds: { type: 'array', items: { type: 'string' }, uniqueItems: true },
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

/** The subset of the report R2 reads once the whole document is schema-valid. */
export interface VerificationReportView {
  schemaVersion: string;
  /** Plain-string alias of schemaVersion; v2.2.0 top-level field. */
  version: string;
  /** Top-level packageHash (v2.2.0); promoted from references.packageHash. */
  packageHash: string | null;
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

/** Validate a parsed report against R6's v2.2.0 schema and extract the view. */
export function validateVerificationReport(value: unknown): ReportValidation {
  if (!compiled(value)) {
    return { ok: false, report: null, errors: (compiled.errors ?? []).map(e => `${e.instancePath} ${e.message}`.trim()) };
  }
  const v = value as Record<string, unknown>;
  const refs = v.references as Record<string, unknown>;
  // Structural cross-checks the schema alone cannot express (both consts are
  // "2.2.0" so Ajv already pins them, but assert the aliasing invariant R6's
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
    },
  };
  return { ok: true, report, errors: [] };
}
