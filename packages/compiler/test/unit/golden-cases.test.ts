import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// Checks the handwritten golden cases against the child-cough fixture.
// This is not Role 4's evaluator. It only locks the shared fixture to the
// three-valued rules the compiler emits, so a later edit cannot silently
// change an expected classification.

const LOGIC = new URL('../fixtures/child-cough.logic.json', import.meta.url);
const SHARED_LOGIC = new URL('../../../../fixtures/child-cough/logic.json', import.meta.url);
const GOLDEN = new URL('../../../../fixtures/child-cough/golden-cases.json', import.meta.url);

const OUTPUT_FIELDS = [
  'classification',
  'in_scope',
  'referral_urgent',
  'follow_up_days',
  'fast_breathing',
  'any_general_danger_sign',
] as const;

type Tri = 'true' | 'false' | 'unknown';
type InputValue = boolean | number | null;
type Input = Record<string, InputValue>;

interface Condition {
  [op: string]: Condition | Condition[] | [string, boolean | number] | string;
}

interface Outcome {
  id: string;
  referral: 'urgent' | 'none';
  followUp?: { afterDays: number };
}

interface LogicModel {
  context: { id: string }[];
  questions: { id: string }[];
  derived: { id: string; when: Condition }[];
  applicability: { when: Condition; notApplicableOutcome: string; unknownOutcome: string };
  decisionTables: { rows: { when: Condition; outcome: string }[]; otherwise: string }[];
  outcomes: Outcome[];
}

interface GoldenCase {
  id: string;
  approval: string;
  basis: string;
  input: Input;
  expected: Record<string, string>;
}

const model = JSON.parse(readFileSync(LOGIC, 'utf8')) as LogicModel;
const cases = JSON.parse(readFileSync(GOLDEN, 'utf8')) as GoldenCase[];

function evalCond(node: Condition, input: Input, derived: ReadonlyMap<string, Tri>): Tri {
  const keys = Object.keys(node);
  if (keys.length !== 1) throw new Error(`condition has keys ${keys.join(',')}`);
  const op = keys[0]!;
  const arg = node[op];

  if (op === 'and' || op === 'or') {
    const parts = (arg as Condition[]).map((child) => evalCond(child, input, derived));
    if (op === 'and') {
      if (parts.includes('false')) return 'false';
      if (parts.includes('unknown')) return 'unknown';
      return 'true';
    }
    if (parts.includes('true')) return 'true';
    if (parts.includes('unknown')) return 'unknown';
    return 'false';
  }

  if (op === 'eq') {
    const [id, literal] = arg as [string, boolean];
    const tri = derived.has(id) ? derived.get(id)! : boolTri(input, id);
    if (tri === 'unknown') return 'unknown';
    return (tri === 'true') === literal ? 'true' : 'false';
  }

  if (op === 'lt' || op === 'gte') {
    const [id, literal] = arg as [string, number];
    const value = numberOrNull(input, id);
    if (value === null) return 'unknown';
    const yes = op === 'lt' ? value < literal : value >= literal;
    return yes ? 'true' : 'false';
  }

  throw new Error(`operator ${op} is not used by the child-cough fixture`);
}

function boolTri(input: Input, id: string): Tri {
  if (!(id in input) || input[id] === null) return 'unknown';
  const value = input[id];
  if (typeof value !== 'boolean') throw new Error(`${id} is not yes/no`);
  return value ? 'true' : 'false';
}

function numberOrNull(input: Input, id: string): number | null {
  if (!(id in input) || input[id] === null) return null;
  const value = input[id];
  if (typeof value !== 'number') throw new Error(`${id} is not a number`);
  return value;
}

function yn(tri: Tri): 'yes' | 'no' | '' {
  if (tri === 'true') return 'yes';
  if (tri === 'false') return 'no';
  return '';
}

/** Report values the compiled form stores. Follow-up days come back as strings. */
function expectFromFixture(input: Input): Record<string, string> {
  const derived = new Map<string, Tri>();
  for (const item of model.derived) derived.set(item.id, evalCond(item.when, input, derived));

  const scope = evalCond(model.applicability.when, input, derived);
  const table = model.decisionTables[0]!;
  let classification = table.otherwise;
  if (scope === 'unknown') classification = model.applicability.unknownOutcome;
  else if (scope === 'false') classification = model.applicability.notApplicableOutcome;
  else {
    const row = table.rows.find((candidate) => evalCond(candidate.when, input, derived) === 'true');
    if (row) classification = row.outcome;
  }

  const outcome = model.outcomes.find((item) => item.id === classification);
  if (!outcome) throw new Error(`classification ${classification} is not an outcome`);
  const days = outcome.followUp?.afterDays;

  return {
    classification,
    in_scope: scope === 'true' ? 'yes' : scope === 'false' ? 'no' : 'unknown',
    referral_urgent: outcome.referral === 'urgent' ? 'yes' : 'no',
    follow_up_days: days === undefined ? '' : String(days),
    fast_breathing: yn(derived.get('fast_breathing')!),
    any_general_danger_sign: yn(derived.get('any_general_danger_sign')!),
  };
}

describe('child-cough golden cases', () => {
  it('keeps the shared logic model identical to the compiler fixture', () => {
    assert.equal(readFileSync(SHARED_LOGIC, 'utf8'), readFileSync(LOGIC, 'utf8'));
  });

  it('is a JSON array of unique cases with the fields Role 6 compares', () => {
    assert.ok(Array.isArray(cases));
    assert.ok(cases.length >= 12);
    const ids = cases.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
    const known = new Set([
      ...model.context.map((item) => item.id),
      ...model.questions.map((item) => item.id),
    ]);
    for (const item of cases) {
      assert.equal(typeof item.id, 'string');
      assert.ok(item.id.length > 0);
      assert.equal(item.approval, 'not-clinician-approved');
      assert.ok(item.basis.length > 0);
      assert.deepEqual(Object.keys(item.expected), [...OUTPUT_FIELDS]);
      for (const key of Object.keys(item.input)) assert.ok(known.has(key), `${item.id} has unknown input ${key}`);
    }
  });

  it('covers every outcome and the age and breathing boundaries', () => {
    const seen = new Set(cases.map((item) => item.expected.classification));
    for (const outcome of model.outcomes) assert.ok(seen.has(outcome.id), `no golden case for ${outcome.id}`);
    const ages = cases.map((item) => item.input.patient_age_in_months);
    for (const age of [1, 2, 11, 12, 59, 60, null]) assert.ok(ages.includes(age), `missing age ${age}`);
    const breaths = cases.map((item) => item.input.breaths_per_minute);
    for (const rate of [49, 50, 39, 40]) assert.ok(breaths.includes(rate), `missing ${rate} breaths`);
  });

  it('matches the fixture rules for every case', () => {
    for (const item of cases) {
      assert.deepEqual(expectFromFixture(item.input), item.expected, item.id);
    }
  });
});
