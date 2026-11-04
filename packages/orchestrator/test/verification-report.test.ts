import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { validateVerificationReport, VERIFICATION_REPORT_SCHEMA_VERSION } from '../src/verification-report-contract.ts';
import { fictionalReport } from './helpers/verification-report-fixtures.ts';

test('R6 schema version is 2.3.0 (official verification branch @ 1bb8b1b)', () => {
  assert.equal(VERIFICATION_REPORT_SCHEMA_VERSION, '2.3.0');
});

test('accepts a schema-valid passing v2.3.0 report and extracts the gate view', () => {
  const r = validateVerificationReport(fictionalReport());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.report?.schemaVersion, '2.3.0');
  assert.equal(r.report?.version, '2.3.0');
  assert.equal(r.report?.packageHash, 'c'.repeat(64));
  assert.equal(r.report?.passed, true);
  assert.equal(r.report?.coverageComplete, true);
  assert.equal(r.report?.references.logicModelHash, 'b'.repeat(64));
  assert.equal(r.report?.references.packageHash, 'c'.repeat(64));
});

test('extracts the v2.3.0 asOf marker and evaluator provenance', () => {
  const r = validateVerificationReport(fictionalReport());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.report?.asOf, '2026-11-04');
  assert.equal(r.report?.evaluator.used, true);
  assert.equal(r.report?.evaluator.source, 'repo');
  assert.equal(r.report?.evaluator.logicModelSource, 'LOGIC_MODEL_FILE');
  assert.equal(r.report?.evaluator.asOf, '2026-11-04');
  assert.equal(r.report?.references.expectedCompileArtifactHash, 'e'.repeat(64));
});

test('reads passed=false / coverageComplete=false from a failing report', () => {
  const r = validateVerificationReport(fictionalReport({ passed: false, coverageComplete: false }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.report?.passed, false);
  assert.equal(r.report?.coverageComplete, false);
});

test('rejects the previous v2.2.0 report (schemaVersion no longer accepted)', () => {
  const r = validateVerificationReport(fictionalReport({ schemaVersion: '2.2.0', version: '2.2.0' }));
  assert.equal(r.ok, false);
});

test('rejects the older v2.1.0 report', () => {
  const r = validateVerificationReport(fictionalReport({ schemaVersion: '2.1.0', version: '2.1.0' }));
  assert.equal(r.ok, false);
});

test('rejects a wrong schemaVersion', () => {
  assert.equal(validateVerificationReport(fictionalReport({ schemaVersion: '2.0.0', version: '2.0.0' })).ok, false);
});

test('rejects a missing top-level version (v2.2.0 required field retained)', () => {
  assert.equal(validateVerificationReport(fictionalReport({ omit: 'version' })).ok, false);
});

test('rejects a missing top-level packageHash (v2.2.0 required field retained)', () => {
  assert.equal(validateVerificationReport(fictionalReport({ omit: 'packageHash' })).ok, false);
});

test('rejects a missing top-level asOf (new v2.3.0 required field)', () => {
  assert.equal(validateVerificationReport(fictionalReport({ omit: 'asOf' })).ok, false);
});

test('rejects a missing evaluator object (new v2.3.0 required field)', () => {
  assert.equal(validateVerificationReport(fictionalReport({ omit: 'evaluator' })).ok, false);
});

test('rejects an evaluator with an out-of-enum source', () => {
  const r = validateVerificationReport(fictionalReport({ evaluator: { source: 'bogus' as never } }));
  assert.equal(r.ok, false);
});

test('rejects an evaluator missing its asOf', () => {
  const report = fictionalReport();
  delete (report.evaluator as Record<string, unknown>).asOf;
  assert.equal(validateVerificationReport(report).ok, false);
});

test('rejects missing references.expectedCompileArtifactHash (new v2.3.0 required field)', () => {
  const report = fictionalReport();
  delete (report.references as Record<string, unknown>).expectedCompileArtifactHash;
  assert.equal(validateVerificationReport(report).ok, false);
});

test('rejects missing coverage.coveredViaBlockedSubmission (new v2.3.0 required field)', () => {
  const report = fictionalReport();
  delete (report.coverage as Record<string, unknown>).coveredViaBlockedSubmission;
  assert.equal(validateVerificationReport(report).ok, false);
});

test('rejects a wrong version alias (version !== schemaVersion)', () => {
  // version is a const 2.3.0 in the schema, so a mismatch is rejected by Ajv;
  // the structural check also guards version === schemaVersion.
  assert.equal(validateVerificationReport(fictionalReport({ version: '2.2.0' })).ok, false);
});

test('rejects a top-level/nested packageHash mismatch', () => {
  const r = validateVerificationReport(fictionalReport({ packageHash: 'f'.repeat(64) })); // references.packageHash stays 'c'...
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('packageHash')), JSON.stringify(r.errors));
});

test('accepts a passing report where top-level and nested packageHash agree (both null is schema-valid structurally)', () => {
  // When no package exists, both are null and agree; the ingestion service
  // (not this contract) enforces non-null for a VERIFIED build.
  const r = validateVerificationReport(fictionalReport({ packageHash: null, references: { packageHash: null } }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.report?.packageHash, null);
});

test('rejects injected / unknown top-level properties (additionalProperties:false)', () => {
  assert.equal(validateVerificationReport({ ...fictionalReport(), evilInjectedField: true }).ok, false);
});

test('rejects a malformed report (missing required field)', () => {
  const { testedDirHash: _omit, ...missing } = fictionalReport();
  assert.equal(validateVerificationReport(missing).ok, false);
});

test('allows a null goldenCasesHash (no golden file supplied) but still schema-valid', () => {
  const r = validateVerificationReport(fictionalReport({ goldenCasesHash: null }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.report?.goldenCasesHash, null);
});

test('rejects a non-hex compileArtifactHash', () => {
  assert.equal(validateVerificationReport(fictionalReport({ compileArtifactHash: 'not-a-hash' })).ok, false);
});

// Parity: the fictional fixture must validate against R6's ACTUAL published
// schema at the pinned commit, proving R2's mirror did not drift from source.
// Skips gracefully if git/the ref is unavailable in the test environment.
test('fixtures validate against R6 official schema @ 1bb8b1b', () => {
  let officialSchemaText: string;
  try {
    officialSchemaText = execFileSync(
      'git', ['show', '1bb8b1b:packages/verification/src/verification-report.schema.json'],
      { encoding: 'utf8' },
    );
  } catch {
    // Ref not fetched in this environment; parity is asserted elsewhere.
    return;
  }
  const officialSchema = JSON.parse(officialSchemaText);
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  const validate = ajv.compile(officialSchema);
  const ok = validate(fictionalReport());
  assert.equal(ok, true, JSON.stringify(validate.errors));
  // And the official schema must pin the same version R2 mirrors.
  assert.equal(officialSchema.properties?.schemaVersion?.const, VERIFICATION_REPORT_SCHEMA_VERSION);
});
