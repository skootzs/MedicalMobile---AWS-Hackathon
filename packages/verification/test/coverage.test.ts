/**
 * Item 2b tests: observed-outcome coverage and manifest/sample branch
 * resolution.
 *
 * Run with node --test on Node 20 and 22, via a glob (not a trailing-slash
 * directory).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeObservedCoverage,
  resolveBranchIds,
  type CompileManifest,
  type CoverageCase,
} from '../src/case-executor.js';
import { buildReport } from '../src/report-builder.js';
import type { Coverage, References, RunInfo, ToolVersions } from '../src/report.js';

const CLASSIFICATION = 'classification';

const SEVEN = [
  'severe_pneumonia_or_very_severe_disease',
  'pneumonia',
  'cough_or_cold',
  'not_in_pathway',
  'out_of_scope',
  'age_unknown',
  'incomplete',
];

const manifest = (): CompileManifest => ({
  formId: 'child_cough',
  snapshotHash: null,
  artifactHash: 'x',
  outputFields: { classification: 'classification' },
  decisionTable: { otherwise: 'incomplete' },
  outcomes: [
    { id: 'severe_pneumonia_or_very_severe_disease' },
    { id: 'pneumonia' },
    { id: 'cough_or_cold' },
    { id: 'not_in_pathway' },
    { id: 'out_of_scope' },
    { id: 'age_unknown' },
    // 'incomplete' comes from decisionTable.otherwise
  ],
});

const caseFor = (cls: string | null): CoverageCase => ({
  actual: cls === null ? null : { classification: cls },
});

test('resolveBranchIds: manifest yields the 7 ids incl. otherwise', () => {
  const r = resolveBranchIds(manifest(), null);
  assert.equal(r.source, 'manifest');
  assert.deepEqual(r.branchIds, SEVEN);
});

test('resolveBranchIds: sample fallback with warning when no outcomes', () => {
  const r = resolveBranchIds({ formId: 'f', snapshotHash: null, artifactHash: 'x' }, ['b1', 'b2']);
  assert.equal(r.source, 'sample');
  assert.deepEqual(r.branchIds, ['b1', 'b2']);
  assert.match(r.source === 'sample' ? r.warning : '', /unconfirmed sample data/);
});

test('all 7 branches hit => none uncovered', () => {
  const cases = SEVEN.map((c) => caseFor(c));
  const { coveredBranchIds, uncoveredBranches } = computeObservedCoverage(SEVEN, cases, CLASSIFICATION);
  assert.equal(coveredBranchIds.length, 7);
  assert.equal(uncoveredBranches.length, 0);
});

test('one branch missing => it is uncovered with a reason', () => {
  const cases = SEVEN.filter((c) => c !== 'incomplete').map((c) => caseFor(c));
  const { coveredBranchIds, uncoveredBranches } = computeObservedCoverage(SEVEN, cases, CLASSIFICATION);
  assert.equal(coveredBranchIds.length, 6);
  assert.deepEqual(uncoveredBranches, [{ id: 'incomplete', reason: 'no executed case reached it' }]);
});

test('status-error case (actual null) does not count as a hit', () => {
  // A null-actual case claiming to be 'pneumonia' must not cover it.
  const cases: CoverageCase[] = [caseFor(null), caseFor('cough_or_cold')];
  const { coveredBranchIds } = computeObservedCoverage(SEVEN, cases, CLASSIFICATION);
  assert.deepEqual(coveredBranchIds, ['cough_or_cold']);
});

// --- Fix 2b-1: coverageComplete false for sample source, empty set, or any uncovered ---

const toolVersions: ToolVersions = {
  node: 'v20', python: 'Python 3.12', chtConf: '6.6.1', chtConfTestHarness: '5.0.4', chromiumRevision: '901912',
};
const run: RunInfo = { command: ['node'], tz: 'Africa/Nairobi', seed: null, fixedClock: '2026-02-15' };
const references: References = {
  snapshotId: null, logicModelHash: null, revision: null,
  clinicalApprovalId: null, compilationJobId: null, packageHash: null,
};
const HASH = '0'.repeat(64);

function reportWithCoverage(coverage: Coverage) {
  return buildReport({
    generatedAt: new Date().toISOString(),
    toolVersions, run, references,
    compileArtifactHash: HASH, testedDirHash: HASH, patientSetHash: HASH, goldenCasesHash: null,
    coverage,
    classificationField: 'classification',
    pageFallbackCaseIds: [],
    integrityChecks: [],
    cases: [],
  });
}

test('2b-1(a): coverageComplete false when branchSource is sample, even if all sample branches hit', () => {
  const coverage: Coverage = {
    method: 'observed-outcome', branchSource: 'sample',
    sampleWarning: 'unconfirmed sample data',
    totalBranches: 2, coveredBranches: 2,
    coveredBranchIds: ['b1', 'b2'], uncoveredBranchIds: [], uncoveredBranches: [],
  };
  assert.equal(reportWithCoverage(coverage).coverageComplete, false);
});

test('2b-1(b): coverageComplete false when the required set is empty', () => {
  const coverage: Coverage = {
    method: 'observed-outcome', branchSource: 'manifest', sampleWarning: null,
    totalBranches: 0, coveredBranches: 0,
    coveredBranchIds: [], uncoveredBranchIds: [], uncoveredBranches: [],
  };
  assert.equal(reportWithCoverage(coverage).coverageComplete, false);
});

test('2b-1(c): coverageComplete false when any branch is uncovered', () => {
  const coverage: Coverage = {
    method: 'observed-outcome', branchSource: 'manifest', sampleWarning: null,
    totalBranches: 2, coveredBranches: 1,
    coveredBranchIds: ['b1'], uncoveredBranchIds: ['b2'],
    uncoveredBranches: [{ id: 'b2', reason: 'no executed case reached it' }],
  };
  assert.equal(reportWithCoverage(coverage).coverageComplete, false);
});

test('2b-1: coverageComplete true only for manifest source, non-empty, all covered', () => {
  const coverage: Coverage = {
    method: 'observed-outcome', branchSource: 'manifest', sampleWarning: null,
    totalBranches: 2, coveredBranches: 2,
    coveredBranchIds: ['b1', 'b2'], uncoveredBranchIds: [], uncoveredBranches: [],
  };
  // buildReport with no cases still forces passed false, but coverageComplete itself is true here.
  assert.equal(reportWithCoverage(coverage).coverageComplete, true);
});

test('2b-2: pageFallbacks detail reports N of M cases', () => {
  const rep = buildReport({
    generatedAt: new Date().toISOString(),
    toolVersions, run, references,
    compileArtifactHash: HASH, testedDirHash: HASH, patientSetHash: HASH, goldenCasesHash: null,
    coverage: {
      method: 'observed-outcome', branchSource: 'manifest', sampleWarning: null,
      totalBranches: 0, coveredBranches: 0, coveredBranchIds: [], uncoveredBranchIds: [], uncoveredBranches: [],
    },
    classificationField: 'classification',
    pageFallbackCaseIds: ['a', 'b'],
    integrityChecks: [],
    cases: [
      { id: 'a', input: {}, branchId: null, kind: 'exceptional', actual: { classification: 'x' }, harnessOutput: null, golden: null, evaluator: null },
      { id: 'b', input: {}, branchId: null, kind: 'exceptional', actual: { classification: 'y' }, harnessOutput: null, golden: null, evaluator: null },
      { id: 'c', input: {}, branchId: null, kind: 'exceptional', actual: { classification: 'z' }, harnessOutput: null, golden: null, evaluator: null },
    ],
  });
  const pf = rep.integrityChecks.find((c) => c.name === 'pageFallbacks')!;
  assert.equal(pf.ok, true);
  assert.match(pf.detail, /2 of 3 cases used the hidden-page fallback/);
});
