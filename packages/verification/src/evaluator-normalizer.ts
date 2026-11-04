/**
 * Translate between the verifier's patient shape and R4's evaluator, using the
 * logic model's own context/questions/outcomes. NO clinical constants.
 *
 * Directions:
 *  - patient -> evaluator answers: age (from DOB + fixed clock, whole months by
 *    the form's difference-in-months rule) into the model's age context id;
 *    yes/no <-> booleans; integers passed through; an omitted/unanswered key is
 *    left out of answers.
 *  - evaluator result -> the fields the verifier compares (manifest output
 *    field names): outcomeId -> classification; referral "urgent" -> yes/no
 *    for referral_urgent; followUpDays -> follow_up_days (string, "" when none);
 *    followUpDate -> the DATE part of t_follow_up_date.
 *
 * A patient that answers a question on a page that would be hidden is an error,
 * surfaced by isHiddenAnswer(); callers must not silently drop it.
 */
import type { JsonValue } from './report.js';

export interface LogicModelLike {
  context?: Array<{ id: string; type: string }>;
  questions?: Array<{ id: string; type: string; page?: string }>;
}

/** Field names the evaluator result maps onto (from manifest.outputFields). */
export interface OutputFieldNames {
  classification: string;
  referralUrgent: string;
  followUpDays: string;
  followUpDate: string;
}

/** The age context id (first integer context var), e.g. patient_age_in_months. */
export function ageContextId(model: LogicModelLike): string {
  const ctx = (model.context ?? []).find((c) => c.type === 'integer');
  return ctx?.id ?? 'patient_age_in_months';
}

/** Whole months between dob and the fixed clock, same day-of-month rule. */
export function monthsBetween(dobIso: string, clockIso: string): number {
  const [dy, dm, dd] = dobIso.split('-').map(Number);
  const [cy, cm, cd] = clockIso.split('-').map(Number);
  let months = (cy - dy) * 12 + (cm - dm);
  if (cd < dd) months -= 1; // not yet reached the day-of-month this month
  return months;
}

/** Maps a verifier input key to the model question id where they differ. */
const INPUT_TO_QUESTION: Record<string, string> = {
  hasCoughOrDifficultBreathing: 'has_cough_or_difficult_breathing',
  breathsPerMinute: 'breaths_per_minute',
  chestIndrawing: 'chest_indrawing',
  stridorInCalmChild: 'stridor_in_calm_child',
};

/**
 * Build evaluator answers from a verifier patient. `ageMonths` (number|null) or
 * a `date_of_birth` is translated to the age context id. Question values are
 * read by model question id, accepting either the camelCase verifier key or
 * the raw form-id key. Unanswered (null / absent) keys are omitted.
 */
export function toEvaluatorAnswers(
  patient: Record<string, JsonValue>,
  model: LogicModelLike,
  opts: { ageMonths: number | null },
): Record<string, JsonValue> {
  const answers: Record<string, JsonValue> = {};
  if (opts.ageMonths !== null) answers[ageContextId(model)] = opts.ageMonths;

  for (const q of model.questions ?? []) {
    const camel = Object.keys(INPUT_TO_QUESTION).find((k) => INPUT_TO_QUESTION[k] === q.id);
    let value: JsonValue | undefined;
    if (camel !== undefined && camel in patient) value = patient[camel];
    else if (q.id in patient) value = patient[q.id];
    else value = undefined;
    if (value === undefined || value === null) continue; // unanswered -> omit
    answers[q.id] = value;
  }
  return answers;
}

/** The evaluator result subset the verifier compares against. */
export interface EvaluatorResult {
  outcomeId: string;
  referral: string;
  followUpDays: number | null;
  followUpDate: string | null;
}

/**
 * Map an evaluator result to the manifest's output field names, matching the
 * string shapes the harness produces (yes/no, "" for empty, date-only).
 */
export function toExpectedFields(r: EvaluatorResult, fields: OutputFieldNames): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  out[fields.classification] = r.outcomeId;
  out[fields.referralUrgent] = r.referral === 'urgent' ? 'yes' : 'no';
  out[fields.followUpDays] = r.followUpDays === null ? '' : String(r.followUpDays);
  // t_follow_up_date in the form is a datetime; compare on the date part only.
  out[fields.followUpDate] = r.followUpDate === null ? '' : r.followUpDate.slice(0, 10);
  return out;
}

/**
 * NOTE: there is no hard-coded hidden-answer detection here. A patient that
 * answers a question on a non-visible page is detected by R4's evaluator
 * itself, which raises a ValueError ("Answer supplied for non-visible
 * question: <id>"); the bridge returns ok:false and the builder maps that to
 * status 'error' with the message. So a hidden answer is always an error,
 * never a pass, with no clinical question ids in this package.
 */
