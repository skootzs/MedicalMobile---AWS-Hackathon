/**
 * Deterministic synthetic-patient generator.
 *
 * No randomness and no seed: the same thresholds.json and branches.json
 * always produce the same patients, in the same order, with the same ids.
 *
 * The generator only decides which inputs to try. It never decides what any
 * input should produce. Expected outcomes come only from golden cases and
 * the evaluator.
 */
import {
  DANGER_SIGN_FIELDS,
  dataStatusWarnings,
  type BranchesData,
  type RateRelation,
  type RespiratoryRateThreshold,
  type SignField,
  type ThresholdsData,
} from './data.js';

export type PatientKind = 'branch' | 'boundary' | 'exceptional';

/**
 * DRAFT: reconcile with the evaluator's input type once packages/evaluator
 * publishes it. Field names mirror the real form's questions.
 *
 * Deliberately has no `expected` field.
 */
export interface PatientInput {
  id: string;
  /** Age in months, or null for no date of birth (age_unknown path). */
  ageMonths: number | null;
  /** breaths_per_minute; null means the breath count was not recorded. */
  breathsPerMinute: number | null;
  /** intro page; null means the question was left unanswered. */
  hasCoughOrDifficultBreathing: boolean | null;
  /** danger_signs page (form order). */
  not_able_to_drink_or_breastfeed: boolean;
  vomits_everything: boolean;
  had_convulsions: boolean;
  lethargic_or_unconscious: boolean;
  convulsing_now: boolean;
  /** breathing page. */
  chestIndrawing: boolean;
  stridorInCalmChild: boolean;
  /**
   * The branch this case was built to exercise, or null for boundary and
   * exceptional cases. This is the generator's intent, not an expected
   * outcome; coverage is measured from what the harness actually hit.
   */
  targetBranch: string | null;
  kind: PatientKind;
}

export interface GenerateOptions {
  /** Receives one warning per unconfirmed data file. Defaults to console.warn. */
  warn?: (message: string) => void;
}

const RELATION_OFFSET: Record<RateRelation, -1 | 0 | 1> = { below: -1, at: 0, above: 1 };

export function generatePatients(
  thresholds: ThresholdsData,
  branches: BranchesData,
  options: GenerateOptions = {},
): PatientInput[] {
  const warn = options.warn ?? ((m: string) => console.warn(m));
  for (const w of dataStatusWarnings(thresholds, branches)) warn(w);

  const bands = thresholds.respiratoryRate.thresholds; // sorted by parseThresholds
  const ageStep = thresholds.ageStepMonths.value;
  const rateStep = thresholds.respiratoryRate.step.value;
  const first = bands[0];
  const last = bands[bands.length - 1];
  if (first === undefined || last === undefined) throw new Error('no respiratory rate thresholds');

  const lowestAge = first.ageMinMonths;
  const rangeEndExclusive = last.ageMaxMonthsExclusive;
  const highestAge = rangeEndExclusive - ageStep;

  /** The band containing `age`, or the nearest band for ages outside all bands. */
  const bandFor = (age: number): RespiratoryRateThreshold => {
    const inside = bands.find((t) => age >= t.ageMinMonths && age < t.ageMaxMonthsExclusive);
    if (inside) return inside;
    let best = first;
    let bestDist = Infinity;
    for (const t of bands) {
      const dist = age < t.ageMinMonths ? t.ageMinMonths - age : age - (t.ageMaxMonthsExclusive - ageStep);
      if (dist < bestDist) {
        best = t;
        bestDist = dist;
      }
    }
    return best;
  };

  const rateAt = (t: RespiratoryRateThreshold, rel: RateRelation): number =>
    t.value + RELATION_OFFSET[rel] * rateStep;
  const rateFor = (age: number, rel: RateRelation): number => rateAt(bandFor(age), rel);

  const out: PatientInput[] = [];
  const ids = new Set<string>();
  const add = (
    id: string,
    kind: PatientKind,
    targetBranch: string | null,
    ageMonths: number | null,
    breathsPerMinute: number | null,
    signs: Partial<Record<SignField, boolean>> = {},
    options: { hasCoughOrDifficultBreathing?: boolean | null } = {},
  ): void => {
    if (ids.has(id)) throw new Error(`duplicate generated patient id "${id}"`);
    ids.add(id);
    const b = branches.baseline;
    out.push({
      id,
      ageMonths,
      breathsPerMinute,
      hasCoughOrDifficultBreathing:
        'hasCoughOrDifficultBreathing' in options
          ? options.hasCoughOrDifficultBreathing ?? null
          : b.hasCoughOrDifficultBreathing,
      not_able_to_drink_or_breastfeed: signs.not_able_to_drink_or_breastfeed ?? b.not_able_to_drink_or_breastfeed,
      vomits_everything: signs.vomits_everything ?? b.vomits_everything,
      had_convulsions: signs.had_convulsions ?? b.had_convulsions,
      lethargic_or_unconscious: signs.lethargic_or_unconscious ?? b.lethargic_or_unconscious,
      convulsing_now: signs.convulsing_now ?? b.convulsing_now,
      chestIndrawing: signs.chestIndrawing ?? b.chestIndrawing,
      stridorInCalmChild: signs.stridorInCalmChild ?? b.stridorInCalmChild,
      targetBranch,
      kind,
    });
  };

  // 1. One clean case per branch, at the lowest covered age.
  for (const br of branches.branches) {
    add(`branch/${br.id}`, 'branch', br.id, lowestAge, rateFor(lowestAge, br.respiratoryRate), br.set);
  }

  // 2. Every numeric threshold: one below, at, one above, at the band's lowest age.
  for (const t of bands) {
    for (const rel of ['below', 'at', 'above'] as const) {
      add(`threshold/${t.id}/${rel}`, 'boundary', null, t.ageMinMonths, rateAt(t, rel));
    }
  }

  // 3. Age edges. Rate sits one step below the threshold for that age (the
  //    nearest band's threshold for ages outside every band).
  const edgeAges = new Set<number>([
    lowestAge, // lowest covered age
    highestAge, // highest covered age
    lowestAge - ageStep, // just outside the range, below
    rangeEndExclusive, // just outside the range, above
  ]);
  for (const t of bands) {
    edgeAges.add(t.ageMinMonths); // at each band's lower edge
    edgeAges.add(t.ageMinMonths - ageStep); // just under each band's lower edge
    edgeAges.add(t.ageMaxMonthsExclusive - ageStep); // just under each band's upper edge
  }
  for (const age of [...edgeAges].sort((a, b) => a - b)) {
    add(`age/${age}m`, 'boundary', null, age, rateFor(age, 'below'));
  }

  // 4. Exceptional inputs.
  add('exceptional/missing-breaths-per-minute', 'exceptional', null, lowestAge, null);
  add('exceptional/no-date-of-birth', 'exceptional', null, null, rateFor(lowestAge, 'below'));
  add('exceptional/age-negative', 'exceptional', null, -ageStep, rateFor(-ageStep, 'below'));
  add('exceptional/no-cough', 'exceptional', null, lowestAge, rateFor(lowestAge, 'below'), {}, {
    hasCoughOrDifficultBreathing: false,
  });
  add('exceptional/cough-unanswered', 'exceptional', null, lowestAge, rateFor(lowestAge, 'below'), {}, {
    hasCoughOrDifficultBreathing: null,
  });
  // One case per named danger sign, each combined with a fast-breathing rate.
  for (const t of bands) {
    for (const sign of DANGER_SIGN_FIELDS) {
      add(
        `exceptional/danger-sign-with-fast-breathing/${t.id}/${sign}`,
        'exceptional',
        null,
        t.ageMinMonths,
        rateAt(t, 'above'),
        { [sign]: true },
      );
    }
  }
  // Every sign at once (with cough answered yes, so all pages are visible).
  // Note: cases that set breathing/danger-sign answers while cough is "no"
  // were removed, because those pages are hidden and the answers cannot be
  // given (Correction B). Plain "no cough" above remains.
  add('exceptional/all-signs-with-fast-breathing', 'exceptional', null, lowestAge, rateFor(lowestAge, 'above'), {
    not_able_to_drink_or_breastfeed: true,
    vomits_everything: true,
    had_convulsions: true,
    lethargic_or_unconscious: true,
    convulsing_now: true,
    chestIndrawing: true,
    stridorInCalmChild: true,
  }, { hasCoughOrDifficultBreathing: true });

  return out;
}

/**
 * Serialise a patient set deterministically: stable key order per patient and
 * a trailing newline, so the file bytes (and their sha256) are reproducible.
 * The array order is the generator's fixed enumeration order.
 */
export function serializePatients(patients: readonly PatientInput[]): string {
  const ordered = patients.map((p) => ({
    id: p.id,
    kind: p.kind,
    targetBranch: p.targetBranch,
    ageMonths: p.ageMonths,
    breathsPerMinute: p.breathsPerMinute,
    hasCoughOrDifficultBreathing: p.hasCoughOrDifficultBreathing,
    not_able_to_drink_or_breastfeed: p.not_able_to_drink_or_breastfeed,
    vomits_everything: p.vomits_everything,
    had_convulsions: p.had_convulsions,
    lethargic_or_unconscious: p.lethargic_or_unconscious,
    convulsing_now: p.convulsing_now,
    chestIndrawing: p.chestIndrawing,
    stridorInCalmChild: p.stridorInCalmChild,
  }));
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
