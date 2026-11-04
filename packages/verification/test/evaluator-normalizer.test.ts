/**
 * Item E3/E6 (quick): normalizer tables. No Python, no clinical constants.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageContextId,
  monthsBetween,
  toEvaluatorAnswers,
  toExpectedFields,
  type LogicModelLike,
} from '../src/evaluator-normalizer.js';

const MODEL: LogicModelLike = {
  context: [{ id: 'patient_age_in_months', type: 'integer' }],
  questions: [
    { id: 'has_cough_or_difficult_breathing', type: 'boolean', page: 'intro' },
    { id: 'not_able_to_drink_or_breastfeed', type: 'boolean', page: 'danger_signs' },
    { id: 'breaths_per_minute', type: 'integer', page: 'breathing' },
    { id: 'chest_indrawing', type: 'boolean', page: 'breathing' },
    { id: 'stridor_in_calm_child', type: 'boolean', page: 'breathing' },
  ],
};
const FIELDS = { classification: 'classification', referralUrgent: 'referral_urgent', followUpDays: 'follow_up_days', followUpDate: 't_follow_up_date' };

test('ageContextId reads the integer context var', () => {
  assert.equal(ageContextId(MODEL), 'patient_age_in_months');
});

test('monthsBetween: whole months, day-of-month rule', () => {
  assert.equal(monthsBetween('2024-02-15', '2026-02-15'), 24); // exact
  assert.equal(monthsBetween('2026-01-15', '2026-02-15'), 1);
  assert.equal(monthsBetween('2024-02-16', '2026-02-15'), 23); // day not yet reached
});

test('toEvaluatorAnswers: camelCase verifier keys -> model question ids; age set', () => {
  const a = toEvaluatorAnswers(
    { hasCoughOrDifficultBreathing: true, breathsPerMinute: 45, not_able_to_drink_or_breastfeed: false },
    MODEL,
    { ageMonths: 24 },
  );
  assert.equal(a['patient_age_in_months'], 24);
  assert.equal(a['has_cough_or_difficult_breathing'], true);
  assert.equal(a['breaths_per_minute'], 45);
  assert.equal(a['not_able_to_drink_or_breastfeed'], false);
});

test('toEvaluatorAnswers: unanswered (null/absent) keys are omitted; no DOB omits age', () => {
  const a = toEvaluatorAnswers({ hasCoughOrDifficultBreathing: null }, MODEL, { ageMonths: null });
  assert.ok(!('patient_age_in_months' in a));
  assert.ok(!('has_cough_or_difficult_breathing' in a));
});

test('toExpectedFields: outcome -> manifest field shapes (yes/no, "", date-only)', () => {
  assert.deepEqual(
    toExpectedFields({ outcomeId: 'pneumonia', referral: 'none', followUpDays: 3, followUpDate: '2026-02-18' }, FIELDS),
    { classification: 'pneumonia', referral_urgent: 'no', follow_up_days: '3', t_follow_up_date: '2026-02-18' },
  );
  assert.deepEqual(
    toExpectedFields({ outcomeId: 'severe_pneumonia_or_very_severe_disease', referral: 'urgent', followUpDays: null, followUpDate: null }, FIELDS),
    { classification: 'severe_pneumonia_or_very_severe_disease', referral_urgent: 'yes', follow_up_days: '', t_follow_up_date: '' },
  );
});


