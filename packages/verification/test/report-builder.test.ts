/**
 * Tests for builder independence (Task 5 E12): the builder derives each
 * source's pass/fail itself from actual vs expected, over the manifest's
 * output fields plus any fields the source names. A precomputed status is
 * never trusted.
 *
 * Run with: node --test (after compiling to JS), on Node 20 and 22.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, deriveCase, evaluateSource } from '../src/report-builder.js';
import type { ExecutedCase, SourceExpectation } from '../src/report-builder.js';
import type { References, RunInfo, ToolVersions } from '../src/report.js';

const OUTPUT_FIELDS = ['classification', 'in_scope'];

function mkCase(overrides: Partial<ExecutedCase>): ExecutedCase {
  return {
    id: 'c1',
    input: {},
    branchId: null,
    kind: 'branch',
    actual: { classification: 'pneumonia', in_scope: 'yes' },
    harnessOutput: null,
    golden: null,
    evaluator: null,
    ...overrides,
  };
}

test('matching values give pass', () => {
  const r = evaluateSource(
    { classification: 'pneumonia', in_scope: 'yes' },
    { expected: { classification: 'pneumonia', in_scope: 'yes' } },
    OUTPUT_FIELDS,
  );
  assert.equal(r.status, 'pass');
});

test('a differing value gives fail', () => {
  const r = evaluateSource(
    { classification: 'pneumonia', in_scope: 'yes' },
    { expected: { classification: 'cough_or_cold', in_scope: 'yes' } },
    OUTPUT_FIELDS,
  );
  assert.equal(r.status, 'fail');
});

test('a source that omits a field the actual has is a fail', () => {
  const r = evaluateSource(
    { classification: 'pneumonia', in_scope: 'yes' },
    { expected: { classification: 'pneumonia' } }, // in_scope omitted
    OUTPUT_FIELDS,
  );
  assert.equal(r.status, 'fail');
});

test("a passed-in status of 'pass' on mismatching values still gives fail", () => {
  // The caller tries to force a pass; the builder must ignore it.
  const sneaky = {
    expected: { classification: 'cough_or_cold', in_scope: 'yes' },
    status: 'pass',
  } as unknown as SourceExpectation;
  const r = evaluateSource({ classification: 'pneumonia', in_scope: 'yes' }, sneaky, OUTPUT_FIELDS);
  assert.equal(r.status, 'fail');
});

test('deriveCase: no source => error; cannot pass without a source', () => {
  const d = deriveCase(mkCase({ golden: null, evaluator: null }), OUTPUT_FIELDS);
  assert.equal(d.status, 'error');
});

test('deriveCase: matching golden => pass', () => {
  const d = deriveCase(
    mkCase({ golden: { expected: { classification: 'pneumonia', in_scope: 'yes' } } }),
    OUTPUT_FIELDS,
  );
  assert.equal(d.status, 'pass');
});

test('deriveCase: golden and evaluator expected differ => disagree', () => {
  const d = deriveCase(
    mkCase({
      golden: { expected: { classification: 'pneumonia', in_scope: 'yes' } },
      evaluator: { expected: { classification: 'cough_or_cold', in_scope: 'yes' } },
    }),
    OUTPUT_FIELDS,
  );
  assert.equal(d.status, 'disagree');
});

// --- buildReport passed rule (Task 6 also covers these) ---

const toolVersions: ToolVersions = {
  node: 'v20',
  python: 'Python 3.12',
  chtConf: '6.6.1',
  chtConfTestHarness: '5.0.4',
  chromiumRevision: '901912',
};
const run: RunInfo = { command: ['node'], tz: 'Africa/Nairobi', seed: null, fixedClock: '2026-02-15' };
const references: References = {
  snapshotId: null, logicModelHash: null, revision: null,
  clinicalApprovalId: null, compilationJobId: null, packageHash: null,
};
const H = '0'.repeat(64);

function baseArgs() {
  return {
    generatedAt: new Date().toISOString(),
    toolVersions, run, references,
    compileArtifactHash: H, testedDirHash: H, patientSetHash: H, goldenCasesHash: null,
    coverage: {
      method: 'observed-outcome' as const,
      branchSource: 'manifest' as const,
      sampleWarning: null,
      totalBranches: 0,
      coveredBranches: 0,
      coveredBranchIds: [] as string[],
      uncoveredBranchIds: [] as string[],
      uncoveredBranches: [] as { id: string; reason: string }[],
    },
    outputFields: OUTPUT_FIELDS,
    pageFallbackCaseIds: [] as string[],
    integrityChecks: [],
  };
}

test('empty cases makes passed false', () => {
  const rep = buildReport({ ...baseArgs(), cases: [] });
  assert.equal(rep.passed, false);
});

test('a failing case makes passed false', () => {
  const rep = buildReport({
    ...baseArgs(),
    cases: [mkCase({ golden: { expected: { classification: 'cough_or_cold', in_scope: 'yes' } } })],
  });
  assert.equal(rep.passed, false);
});

test('incomplete coverage makes passed false', () => {
  const rep = buildReport({
    ...baseArgs(),
    coverage: {
      method: 'observed-outcome' as const,
      branchSource: 'manifest' as const,
      sampleWarning: null,
      totalBranches: 1,
      coveredBranches: 0,
      coveredBranchIds: [] as string[],
      uncoveredBranchIds: ['b1'],
      uncoveredBranches: [{ id: 'b1', reason: 'no executed case reached it' }],
    },
    cases: [mkCase({ golden: { expected: { classification: 'pneumonia', in_scope: 'yes' } } })],
  });
  assert.equal(rep.passed, false);
});

test('a failed integrity check makes passed false', () => {
  const rep = buildReport({
    ...baseArgs(),
    integrityChecks: [{ name: 'compileArtifactHash', ok: false, detail: 'mismatch' }],
    cases: [mkCase({ golden: { expected: { classification: 'pneumonia', in_scope: 'yes' } } })],
  });
  assert.equal(rep.passed, false);
});

test('pageFallbacks lists ids and stays ok:true', () => {
  const rep = buildReport({ ...baseArgs(), pageFallbackCaseIds: ['x', 'y'], cases: [] });
  const pf = rep.integrityChecks.find((c) => c.name === 'pageFallbacks')!;
  assert.equal(pf.ok, true);
  assert.match(pf.detail, /x, y/);
});
