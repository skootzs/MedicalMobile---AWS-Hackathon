/**
 * Loaders and shape checks for the generator's input data:
 * thresholds.json and branches.json (see packages/synth/data).
 *
 * These files hold the thresholds and branch targets the generator walks.
 * They never hold expected outcomes. Every value is unconfirmed until
 * dataStatus is "confirmed".
 *
 * Validation is hand-written (no schema library) so this package adds no
 * dependencies. It rejects malformed data instead of guessing.
 */
import { readFileSync } from 'node:fs';

/** The only dataStatus value that suppresses the unconfirmed-data warning. */
export const CONFIRMED_DATA_STATUS = 'confirmed';

/**
 * Where a case's respiratory rate sits, numerically, relative to the
 * threshold for its age. This is numeric position only; it says nothing
 * about whether the threshold is met (that depends on the operator and is
 * the evaluator's job).
 */
export type RateRelation = 'below' | 'at' | 'above';

export type ThresholdOperator = '>=' | '>' | '<=' | '<';

/** Boolean inputs a branch target may set. */
export type SignField =
  | 'hasCoughOrDifficultBreathing'
  | 'generalDangerSign'
  | 'chestIndrawing'
  | 'stridorInCalmChild';

export const SIGN_FIELDS: readonly SignField[] = [
  'hasCoughOrDifficultBreathing',
  'generalDangerSign',
  'chestIndrawing',
  'stridorInCalmChild',
];

export interface StepValue {
  value: number;
  confirmed: boolean;
}

export interface RespiratoryRateThreshold {
  id: string;
  ageMinMonths: number;
  ageMaxMonthsExclusive: number;
  operator: ThresholdOperator;
  value: number;
  sourcePassage: string;
  confirmed: boolean;
}

export interface ThresholdsData {
  dataStatus: string;
  ageStepMonths: StepValue;
  respiratoryRate: {
    unit: string;
    step: StepValue;
    /** Sorted by ageMinMonths, then id, for deterministic iteration. */
    thresholds: RespiratoryRateThreshold[];
  };
}

export type Baseline = Record<SignField, boolean> & { confirmed: boolean };

export interface BranchSpec {
  id: string;
  label: string;
  /** Sign fields this branch's clean case sets on top of the baseline. */
  set: Partial<Record<SignField, boolean>>;
  /** Where the clean case's respiratory rate sits relative to its threshold. */
  respiratoryRate: RateRelation;
  sourcePassage: string;
  confirmed: boolean;
}

export interface BranchesData {
  dataStatus: string;
  baseline: Baseline;
  /** In file order. */
  branches: BranchSpec[];
}

// ---------------------------------------------------------------------------
// Shape helpers

type Obj = Record<string, unknown>;

function fail(file: string, path: string, problem: string): never {
  throw new Error(`${file}: ${path} ${problem}`);
}

function obj(file: string, path: string, v: unknown): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    fail(file, path, 'must be an object');
  }
  return v as Obj;
}

function str(file: string, path: string, v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) fail(file, path, 'must be a non-empty string');
  return v;
}

function num(file: string, path: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(file, path, 'must be a finite number');
  return v;
}

function bool(file: string, path: string, v: unknown): boolean {
  if (typeof v !== 'boolean') fail(file, path, 'must be a boolean');
  return v;
}

function arr(file: string, path: string, v: unknown): unknown[] {
  if (!Array.isArray(v)) fail(file, path, 'must be an array');
  return v;
}

function step(file: string, path: string, v: unknown): StepValue {
  const o = obj(file, path, v);
  const value = num(file, `${path}.value`, o['value']);
  if (value <= 0) fail(file, `${path}.value`, 'must be greater than 0');
  return { value, confirmed: bool(file, `${path}.confirmed`, o['confirmed']) };
}

const OPERATORS: readonly ThresholdOperator[] = ['>=', '>', '<=', '<'];
const RELATIONS: readonly RateRelation[] = ['below', 'at', 'above'];

// ---------------------------------------------------------------------------
// thresholds.json

export function parseThresholds(raw: unknown, file = 'thresholds.json'): ThresholdsData {
  const root = obj(file, '(root)', raw);
  const rr = obj(file, 'respiratoryRate', root['respiratoryRate']);
  const list = arr(file, 'respiratoryRate.thresholds', rr['thresholds']);
  if (list.length === 0) fail(file, 'respiratoryRate.thresholds', 'must not be empty');

  const seen = new Set<string>();
  const thresholds = list.map((item, i): RespiratoryRateThreshold => {
    const p = `respiratoryRate.thresholds[${i}]`;
    const t = obj(file, p, item);
    const id = str(file, `${p}.id`, t['id']);
    if (seen.has(id)) fail(file, `${p}.id`, `duplicates "${id}"`);
    seen.add(id);
    const operator = t['operator'];
    if (!OPERATORS.includes(operator as ThresholdOperator)) {
      fail(file, `${p}.operator`, `must be one of ${OPERATORS.join(' ')}`);
    }
    const ageMinMonths = num(file, `${p}.ageMinMonths`, t['ageMinMonths']);
    const ageMaxMonthsExclusive = num(file, `${p}.ageMaxMonthsExclusive`, t['ageMaxMonthsExclusive']);
    if (ageMaxMonthsExclusive <= ageMinMonths) {
      fail(file, p, 'ageMaxMonthsExclusive must be greater than ageMinMonths');
    }
    return {
      id,
      ageMinMonths,
      ageMaxMonthsExclusive,
      operator: operator as ThresholdOperator,
      value: num(file, `${p}.value`, t['value']),
      sourcePassage: str(file, `${p}.sourcePassage`, t['sourcePassage']),
      confirmed: bool(file, `${p}.confirmed`, t['confirmed']),
    };
  });

  thresholds.sort((a, b) => a.ageMinMonths - b.ageMinMonths || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 1; i < thresholds.length; i++) {
    const prev = thresholds[i - 1]!;
    const cur = thresholds[i]!;
    if (cur.ageMinMonths < prev.ageMaxMonthsExclusive) {
      fail(file, 'respiratoryRate.thresholds', `age bands "${prev.id}" and "${cur.id}" overlap`);
    }
  }

  return {
    dataStatus: str(file, 'dataStatus', root['dataStatus']),
    ageStepMonths: step(file, 'ageStepMonths', root['ageStepMonths']),
    respiratoryRate: {
      unit: str(file, 'respiratoryRate.unit', rr['unit']),
      step: step(file, 'respiratoryRate.step', rr['step']),
      thresholds,
    },
  };
}

// ---------------------------------------------------------------------------
// branches.json

export function parseBranches(raw: unknown, file = 'branches.json'): BranchesData {
  const root = obj(file, '(root)', raw);
  const b = obj(file, 'baseline', root['baseline']);
  const baseline = { confirmed: bool(file, 'baseline.confirmed', b['confirmed']) } as Baseline;
  for (const f of SIGN_FIELDS) baseline[f] = bool(file, `baseline.${f}`, b[f]);

  const list = arr(file, 'branches', root['branches']);
  if (list.length === 0) fail(file, 'branches', 'must not be empty');

  const seen = new Set<string>();
  const branches = list.map((item, i): BranchSpec => {
    const p = `branches[${i}]`;
    const o = obj(file, p, item);
    const id = str(file, `${p}.id`, o['id']);
    if (seen.has(id)) fail(file, `${p}.id`, `duplicates "${id}"`);
    seen.add(id);

    const setRaw = obj(file, `${p}.set`, o['set']);
    const set: Partial<Record<SignField, boolean>> = {};
    for (const key of Object.keys(setRaw).sort()) {
      if (!SIGN_FIELDS.includes(key as SignField)) {
        fail(file, `${p}.set.${key}`, `is not one of ${SIGN_FIELDS.join(', ')}`);
      }
      set[key as SignField] = bool(file, `${p}.set.${key}`, setRaw[key]);
    }

    const rel = o['respiratoryRate'];
    if (!RELATIONS.includes(rel as RateRelation)) {
      fail(file, `${p}.respiratoryRate`, `must be one of ${RELATIONS.join(', ')}`);
    }

    return {
      id,
      label: str(file, `${p}.label`, o['label']),
      set,
      respiratoryRate: rel as RateRelation,
      sourcePassage: str(file, `${p}.sourcePassage`, o['sourcePassage']),
      confirmed: bool(file, `${p}.confirmed`, o['confirmed']),
    };
  });

  return { dataStatus: str(file, 'dataStatus', root['dataStatus']), baseline, branches };
}

// ---------------------------------------------------------------------------
// File loaders

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadThresholds(path: string): ThresholdsData {
  return parseThresholds(readJson(path), path);
}

export function loadBranches(path: string): BranchesData {
  return parseBranches(readJson(path), path);
}

/** One warning per data file whose dataStatus is not "confirmed". */
export function dataStatusWarnings(thresholds: ThresholdsData, branches: BranchesData): string[] {
  const warnings: string[] = [];
  const check = (name: string, status: string): void => {
    if (status !== CONFIRMED_DATA_STATUS) {
      warnings.push(
        `WARNING: ${name} dataStatus is "${status}", not "${CONFIRMED_DATA_STATUS}". ` +
          'Generated patients are built from unconfirmed sample data and must not be used as release evidence.',
      );
    }
  };
  check('thresholds.json', thresholds.dataStatus);
  check('branches.json', branches.dataStatus);
  return warnings;
}
