/**
 * Maps a synth PatientInput to the harness's per-page answer arrays.
 *
 * Page order and question names come from derivePages (compile-rows.json). The
 * mapper holds NO clinical constants: no age ranges, no breathing thresholds.
 * It only translates the input's field values into the yes/no and integer
 * answer strings each named question expects, in page/question order.
 *
 * Empirically (Task 5 B5), every question on a visible page is required: an
 * unanswered question yields a required-constraint validation error and the
 * form does not submit. So a null field is emitted as an empty answer and the
 * executor will record the resulting error; the mapper never invents a value.
 */
import type { JsonValue } from './report.js';

/** The PatientInput fields the mapper reads. Mirrors synth's PatientInput. */
export interface MappablePatient {
  ageMonths?: number | null;
  breathsPerMinute?: number | null;
  hasCoughOrDifficultBreathing?: boolean | null;
  [question: string]: JsonValue | undefined;
}

export interface PageSpecLike {
  name: string;
  questions: string[];
}

/** yes/no choice names, or '' for an unanswered boolean. */
function yesNo(v: boolean | null | undefined): string {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return '';
}

/** Integer answer as a string, or '' when not recorded. */
function intAnswer(v: number | null | undefined): string {
  return typeof v === 'number' ? String(v) : '';
}

/**
 * Map input field names (camelCase on PatientInput) to the form's question
 * names where they differ. Danger-sign questions already use the form's names.
 */
const QUESTION_TO_INPUT: Record<string, string> = {
  has_cough_or_difficult_breathing: 'hasCoughOrDifficultBreathing',
  breaths_per_minute: 'breathsPerMinute',
  chest_indrawing: 'chestIndrawing',
  stridor_in_calm_child: 'stridorInCalmChild',
  // danger signs map to themselves (same names on PatientInput)
  not_able_to_drink_or_breastfeed: 'not_able_to_drink_or_breastfeed',
  vomits_everything: 'vomits_everything',
  had_convulsions: 'had_convulsions',
  lethargic_or_unconscious: 'lethargic_or_unconscious',
  convulsing_now: 'convulsing_now',
};

/** Integer-valued questions; everything else is treated as yes/no. */
const INTEGER_QUESTIONS = new Set(['breaths_per_minute']);

/**
 * Build one answer array per page, in page order, each holding one answer per
 * question in that page's order. Note-only pages (no questions) yield an empty
 * array. ageMonths is NOT a page answer; it is carried via date_of_birth by
 * the executor, so the mapper ignores it here.
 */
export function mapPatientToPages(patient: MappablePatient, pages: readonly PageSpecLike[]): string[][] {
  return pages.map((page) =>
    page.questions.map((q) => {
      // Accept either the camelCase synth key or the raw form-id key (golden
      // cases use the form id directly). Prefer whichever is present.
      const camel = QUESTION_TO_INPUT[q];
      const value = camel !== undefined && camel in patient ? patient[camel] : patient[q];
      if (INTEGER_QUESTIONS.has(q)) return intAnswer(value as number | null | undefined);
      return yesNo(value as boolean | null | undefined);
    }),
  );
}
