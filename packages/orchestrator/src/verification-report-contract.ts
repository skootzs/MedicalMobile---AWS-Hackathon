/**
 * R6 VerificationReport contract.
 *
 * The authoritative schema is
 *   packages/verification/src/verification-report.schema.json
 * on this branch. This module loads that file. It does not keep a second copy.
 *
 * R2 uses it to validate a fetched report and to read the gate fields and
 * echoed references. R2 does not compute verification outcomes.
 */
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

const schemaPath = new URL('../../verification/src/verification-report.schema.json', import.meta.url);
export const verificationReportSchema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
  properties: { schemaVersion: { const: string } };
};

/** The schemaVersion R6 publishes in the schema file on this branch. */
export const VERIFICATION_REPORT_SCHEMA_VERSION = verificationReportSchema.properties.schemaVersion.const;

/** The subset of the report R2 reads once the whole document is schema-valid. */
export interface VerificationReportView {
  schemaVersion: string;
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

/** Validate a parsed report against R6's published schema and extract the view. */
export function validateVerificationReport(value: unknown): ReportValidation {
  if (!compiled(value)) {
    return { ok: false, report: null, errors: (compiled.errors ?? []).map(e => `${e.instancePath} ${e.message}`.trim()) };
  }
  const v = value as Record<string, unknown>;
  const refs = v.references as Record<string, unknown>;
  const report: VerificationReportView = {
    schemaVersion: v.schemaVersion as string,
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
      packageHash: (refs.packageHash as string | null) ?? null,
    },
  };
  return { ok: true, report, errors: [] };
}
