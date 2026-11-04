import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVerificationReport, VERIFICATION_REPORT_SCHEMA_VERSION } from '../src/verification-report-contract.ts';
import { fictionalReport } from './helpers/verification-report-fixtures.ts';

test('R6 schema version matches the published verification-report schema', () => {
  assert.equal(VERIFICATION_REPORT_SCHEMA_VERSION, '2.2.0');
});

test('accepts a schema-valid passing report and extracts the gate view', () => {
  const r = validateVerificationReport(fictionalReport());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
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

test('rejects a wrong schemaVersion (e.g. R7 comment hint 2.0.0)', () => {
  const r = validateVerificationReport(fictionalReport({ schemaVersion: '2.0.0' }));
  assert.equal(r.ok, false);
});

test('rejects injected / unknown top-level properties (additionalProperties:false)', () => {
  const r = validateVerificationReport({ ...fictionalReport(), evilInjectedField: true });
  assert.equal(r.ok, false);
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

test('rejects a report whose version or package hash disagrees with itself', () => {
  const drifted = fictionalReport();
  drifted.packageHash = 'd'.repeat(64);
  assert.equal(validateVerificationReport(drifted).ok, false);
  const renamed = fictionalReport();
  renamed.version = '2.0.0';
  assert.equal(validateVerificationReport(renamed).ok, false);
});

test('rejects a non-hex compileArtifactHash', () => {
  assert.equal(validateVerificationReport(fictionalReport({ compileArtifactHash: 'not-a-hash' })).ok, false);
});
