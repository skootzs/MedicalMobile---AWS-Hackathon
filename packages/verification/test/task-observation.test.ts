/**
 * Item C: task observation. The PatientExecutor records OBSERVED task fields
 * (task_present, task_due_in_days) on actual when observeTasks is on. These are
 * observations, never expected values.
 *
 * Tested with a fake harness that raises a follow-up task a fixed number of
 * days after submission, so no built project is needed here. (The real
 * 7f488e6 build is exercised out-of-band; see the item C report.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PatientExecutor, type FillResult, type HarnessLike, type HarnessTask } from '../src/case-executor.js';

const DAY = 86_400_000;
const CLOCK = '2026-11-04';
const clockMs = Date.parse('2026-11-04T00:00:00Z');

/**
 * Fake harness: always submits, and (if dueInDays is not null) exposes a
 * follow-up task due dueInDays after the clock, but only once the mock clock
 * has advanced to at least the due date (like the real task window start).
 */
function fakeHarness(dueInDays: number | null): HarnessLike {
  let now = clockMs;
  return {
    async start() {},
    async stop() {},
    async clear() {
      now = clockMs;
    },
    setNow(n: string) {
      now = Date.parse(n.includes('T') ? n : n + 'T00:00:00Z');
    },
    async fillForm(): Promise<FillResult> {
      return { report: { fields: { classification: 'pneumonia' } }, errors: [] };
    },
    getNow() {
      return now;
    },
    async flush(amount: number) {
      now += amount * DAY;
    },
    async getTasks(): Promise<HarnessTask[]> {
      if (dueInDays === null) return [];
      const dueDate = clockMs + dueInDays * DAY;
      return now >= dueDate ? [{ emission: { title: 'task.child_cough.follow_up.title', dueDate } }] : [];
    },
  };
}

function makeExec(h: HarnessLike): PatientExecutor {
  return new PatientExecutor({
    harness: h,
    formId: 'child_cough',
    rowsFilePath: '/n/a',
    fixedClock: CLOCK,
    outputFields: ['classification'],
    observeTasks: true,
    taskWindowDays: 10,
  });
}

test('records task_present true and task_due_in_days when a follow-up appears on day 3', async () => {
  const r = await makeExec(fakeHarness(3)).run({ id: 'p', input: { ageMonths: 24, pageAnswers: [['yes']] } });
  assert.equal(r.status, 'ok');
  assert.equal(r.actual?.['task_present'], true);
  assert.equal(r.actual?.['task_due_in_days'], 3);
});

test('records task_present false / null when no follow-up is raised', async () => {
  const r = await makeExec(fakeHarness(null)).run({ id: 'p', input: { ageMonths: 24, pageAnswers: [['yes']] } });
  assert.equal(r.actual?.['task_present'], false);
  assert.equal(r.actual?.['task_due_in_days'], null);
});

test('task fields are omitted when observeTasks is off', async () => {
  const exec = new PatientExecutor({
    harness: fakeHarness(3),
    formId: 'child_cough',
    rowsFilePath: '/n/a',
    fixedClock: CLOCK,
    outputFields: ['classification'],
    // observeTasks not set
  });
  const r = await exec.run({ id: 'p', input: { ageMonths: 24, pageAnswers: [['yes']] } });
  assert.ok(r.actual && !('task_present' in r.actual));
});

test('task observation is skipped (no throw) when the harness lacks getTasks', async () => {
  const minimal: HarnessLike = {
    async start() {}, async stop() {}, async clear() {}, setNow() {},
    async fillForm(): Promise<FillResult> {
      return { report: { fields: { classification: 'pneumonia' } }, errors: [] };
    },
    // no getTasks/flush/getNow
  };
  const r = await makeExec(minimal).run({ id: 'p', input: { ageMonths: 24, pageAnswers: [['yes']] } });
  assert.equal(r.actual?.['task_present'], false);
  assert.equal(r.actual?.['task_due_in_days'], null);
});

test('dobForAgeMonths produces an exact same-day-of-month DOB (DOB override basis)', () => {
  const exec = makeExec(fakeHarness(null));
  // clock 2026-11-04; 6 months earlier, same day => 2026-05-04.
  assert.equal(exec.dobForAgeMonths(6), '2026-05-04');
  // 24 months earlier => 2024-11-04 (the template default child's DOB).
  assert.equal(exec.dobForAgeMonths(24), '2024-11-04');
});
