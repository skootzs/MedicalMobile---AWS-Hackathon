/**
 * Part 6: mapper and progressive-truncation fallback tests.
 *
 * The mapper is tested with explicit page specs (no form file needed). The
 * truncation fallback is tested against a fake harness that hides pages the
 * way the real one does.
 *
 * Run with node --test on Node 20 and 22 via a glob.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPatientToPages, type PageSpecLike } from '../src/patient-mapper.js';
import { PatientExecutor, type FillResult, type HarnessLike } from '../src/case-executor.js';

const PAGES: PageSpecLike[] = [
  { name: 'intro', questions: ['has_cough_or_difficult_breathing'] },
  {
    name: 'danger_signs',
    questions: [
      'not_able_to_drink_or_breastfeed',
      'vomits_everything',
      'had_convulsions',
      'lethargic_or_unconscious',
      'convulsing_now',
    ],
  },
  { name: 'breathing', questions: ['breaths_per_minute', 'chest_indrawing', 'stridor_in_calm_child'] },
  { name: 'summary', questions: [] },
];

const base = {
  not_able_to_drink_or_breastfeed: false,
  vomits_everything: false,
  had_convulsions: false,
  lethargic_or_unconscious: false,
  convulsing_now: false,
  chestIndrawing: false,
  stridorInCalmChild: false,
};

test('mapper: in-scope patient maps yes/no and integer answers in order', () => {
  const pages = mapPatientToPages(
    { ...base, ageMonths: 24, hasCoughOrDifficultBreathing: true, breathsPerMinute: 45 },
    PAGES,
  );
  assert.deepEqual(pages, [['yes'], ['no', 'no', 'no', 'no', 'no'], ['45', 'no', 'no'], []]);
});

test('mapper: cough=no maps the intro page to no', () => {
  const pages = mapPatientToPages(
    { ...base, ageMonths: 24, hasCoughOrDifficultBreathing: false, breathsPerMinute: 45 },
    PAGES,
  );
  assert.equal(pages[0]![0], 'no');
});

test('mapper: null fields become empty answers', () => {
  const pages = mapPatientToPages(
    { ...base, ageMonths: null, hasCoughOrDifficultBreathing: null, breathsPerMinute: null },
    PAGES,
  );
  assert.equal(pages[0]![0], ''); // cough unanswered
  assert.equal(pages[2]![0], ''); // breaths unanswered
});

/** Fake harness: only the first `visiblePages` answer arrays are fillable. */
function fakeHarness(visiblePages: number): HarnessLike {
  return {
    async start() {},
    async stop() {},
    async clear() {},
    setNow() {},
    async fillForm(_load: unknown, ...pages: unknown[]): Promise<FillResult> {
      // A single empty array ([[]]) always submits: no visible question page to
      // fill, like the real harness's minimal submission.
      const isEmptyFill = pages.length === 1 && Array.isArray(pages[0]) && (pages[0] as unknown[]).length === 0;
      if (!isEmptyFill && pages.length > visiblePages) {
        return { errors: [{ type: 'page', section: 'answer-0', msg: 'Attempted to fill 5 questions, but only 0 are visible.' }] };
      }
      return { report: { fields: { classification: 'result', in_scope: 'yes' } }, errors: [] };
    },
  };
}

function makeExecutor(h: HarnessLike): PatientExecutor {
  return new PatientExecutor({
    harness: h,
    formId: 'child_cough',
    rowsFilePath: '/does/not/matter',
    fixedClock: '2026-02-15',
    outputFields: ['classification', 'in_scope'],
  });
}

test('truncation: all 4 pages visible => no fallback', async () => {
  const exec = makeExecutor(fakeHarness(4));
  const r = await exec.run({ id: 'x', input: { ageMonths: 24, pageAnswers: [['yes'], [], [], []] } });
  assert.equal(r.status, 'ok');
  assert.equal(r.usedPageFallback, false);
});

test('truncation: only 1 page visible => falls back to 1 page array', async () => {
  const exec = makeExecutor(fakeHarness(1));
  const r = await exec.run({ id: 'x', input: { ageMonths: 24, pageAnswers: [['no'], ['no'], ['45'], []] } });
  assert.equal(r.status, 'ok');
  assert.equal(r.usedPageFallback, true);
});

test('truncation: zero pages visible => falls back to [[]]', async () => {
  const exec = makeExecutor(fakeHarness(0));
  const r = await exec.run({ id: 'x', input: { ageMonths: 1, pageAnswers: [['yes'], ['no'], ['45'], []] } });
  assert.equal(r.status, 'ok');
  assert.equal(r.usedPageFallback, true);
});
