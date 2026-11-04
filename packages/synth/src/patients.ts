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
 * publishes it. Field names and units here are provisional.
 *
 * Deliberately has no `expected` field.
 */
export interface PatientInput {
  id: string;
  ageMonths: number;
  /** null means the rate was not recorded. */
  respiratoryRate: number | null;
  hasCoughOrDifficultBreathing: boolean;
  generalDangerSign: boolean;
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
    ageMonths: number,
    respiratoryRate: number | null,
    signs: Partial<Record<SignField, boolean>> = {},
  ): void => {
    if (ids.has(id)) throw new Error(`duplicate generated patient id "${id}"`);
    ids.add(id);
    const b = branches.baseline;
    out.push({
      id,
      ageMonths,
      respiratoryRate,
      hasCoughOrDifficultBreathing: signs.hasCoughOrDifficultBreathing ?? b.hasCoughOrDifficultBreathing,
      generalDangerSign: signs.generalDangerSign ?? b.generalDangerSign,
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
  add('exceptional/missing-respiratory-rate', 'exceptional', null, lowestAge, null);
  add('exceptional/age-negative', 'exceptional', null, -ageStep, rateFor(-ageStep, 'below'));
  add('exceptional/no-cough', 'exceptional', null, lowestAge, rateFor(lowestAge, 'below'), {
    hasCoughOrDifficultBreathing: false,
  });
  for (const t of bands) {
    add(
      `exceptional/danger-sign-with-fast-breathing/${t.id}`,
      'exceptional',
      null,
      t.ageMinMonths,
      rateAt(t, 'above'),
      { generalDangerSign: true },
    );
  }
  // Contradictory combinations: signs recorded without the entry symptom,
  // and every sign at once.
  add('exceptional/no-cough-with-chest-indrawing', 'exceptional', null, lowestAge, rateFor(lowestAge, 'below'), {
    hasCoughOrDifficultBreathing: false,
    chestIndrawing: true,
  });
  add('exceptional/no-cough-with-fast-breathing', 'exceptional', null, lowestAge, rateFor(lowestAge, 'above'), {
    hasCoughOrDifficultBreathing: false,
  });
  add('exceptional/all-signs-with-fast-breathing', 'exceptional', null, lowestAge, rateFor(lowestAge, 'above'), {
    hasCoughOrDifficultBreathing: true,
    generalDangerSign: true,
    chestIndrawing: true,
    stridorInCalmChild: true,
  });

  return out;
}
