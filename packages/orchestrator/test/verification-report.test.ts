import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVerificationReport, VERIFICATION_REPORT_SCHEMA_VERSION } from '../src/verification-report-contract.ts';
import { fictionalReport } from './helpers/verification-report-fixtures.ts';

test('R6 schema version is 2.2.0 (official integrate/compiler @ 99001e8)', () => {
  assert.equal(VERIFICATION_REPORT_SCHEMA_VERSION, '2.2.0');
});

test('accepts a schema-valid passing v2.2.0 report and extracts the gate view', () => {
  const r = validateVerificationReport(fictionalReport());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.report?.schemaVersion, '2.2.0');
  assert.equal(r.report?.version, '2.2.0');
  assert.equal(r.report?.packageHash, 'c'.repeat(64));
  assert.equal(r.report?.passed, true);
  assert.equal(r.report?.coverageComplete, true);
  assert.equal(r.report?.references.logicModelHash, 'b'.repeat(64));
  assert.equal(r.report?.references.packageHash, 'c'.repeat(64));
});

test('reads passed=false / coverageComplete=false from a failing report', () => {
  const r = validateVerificationReport(fictionalReport({ passed: false, coverageComplete: false }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.report?.passed, false);
  assert.equal(r.report?.coverageComplete, false);
});

test('rejects the previous v2.1.0 report (schemaVersion no longer accepted)', () => {
  const r = validateVerificationReport(fictionalReport({ schemaVersion: '2.1.0', version: '2.1.0' }));
  assert.equal(r.ok, false);
});

test('rejects a wrong schemaVersion', () => {
  assert.equal(validateVerificationReport(fictionalReport({ schemaVersion: '2.0.0', version: '2.0.0' })).ok, false);
});

test('rejects a missing top-level version (new v2.2.0 required field)', () => {
  assert.equal(validateVerificationReport(fictionalReport({ omit: 'version' })).ok, false);
});

test('rejects a missing top-level packageHash (new v2.2.0 required field)', () => {
  assert.equal(validateVerificationReport(fictionalReport({ omit: 'packageHash' })).ok, false);
});

test('rejects a wrong version alias (version !== schemaVersion)', () => {
  // version is a const 2.2.0 in the schema, so a mismatch is rejected by Ajv;
  // the structural check also guards version === schemaVersion.
  assert.equal(validateVerificationReport(fictionalReport({ version: '2.1.0' })).ok, false);
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
