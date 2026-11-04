// Evaluates one LogicModel the way the compiled form does.
// Rows are tried in order. The first row that is definitely true wins.
// A later row that is also true is recorded in matchedRows and does not change the result.
// Applicability is decided before the table.

import { evalCondition, yn, type Answers, type ConditionNode, type InputValue, type Tri } from './conditions.ts';

export interface OutcomeDef {
  id: string;
  referral: 'urgent' | 'none';
  followUp?: { afterDays: number };
}

export interface LogicModel {
  applicability?: { when: ConditionNode; notApplicableOutcome: string; unknownOutcome: string };
  context?: { id: string }[];
  questions: { id: string; type: string; options?: { id: string }[] }[];
  derived: { id: string; when: ConditionNode }[];
  decisionTables: { id?: string; hitPolicy?: string; rows: { when: ConditionNode; outcome: string }[]; otherwise: string }[];
  outcomes: OutcomeDef[];
}

export interface Evaluation {
  classification: string;
  inScope: 'yes' | 'no' | 'unknown';
  referralUrgent: 'yes' | 'no';
  followUpDays: string;
  derived: Record<string, 'yes' | 'no' | ''>;
  /** Indexes of decision rows that are definitely true. More than one is an overlap. */
  matchedRows: number[];
}

const KNOWN = new Set(['boolean', 'integer', 'decimal', 'select_one']);

export function evaluateLogicModel(model: LogicModel, answers: Answers): Evaluation {
  const questions = new Map(model.questions.map((question) => [question.id, question]));
  const contextIds = new Set((model.context ?? []).map((item) => item.id));
  for (const key of Object.keys(answers)) {
    if (!questions.has(key) && !contextIds.has(key)) throw new Error(`Unknown input ${key}`);
  }

  const readRaw = (id: string): InputValue | undefined => {
    if (!(id in answers)) return undefined;
    return answers[id];
  };

  const derived = new Map<string, Tri>();

  for (const item of model.derived) {
    derived.set(item.id, evalCondition(item.when, (ref) => {
      if (derived.has(ref)) {
        const tri = derived.get(ref)!;
        if (tri === 'unknown') return undefined;
        return tri === 'true';
      }
      return readRaw(ref);
    }));
  }

  // Derived values are yes/no atoms in later conditions, not the original inputs.
  const lookupTri = (id: string): Tri | InputValue | undefined => {
    if (derived.has(id)) {
      const tri = derived.get(id)!;
      if (tri === 'unknown') return undefined;
      return tri === 'true';
    }
    const question = questions.get(id);
    const raw = readRaw(id);
    if (question && !KNOWN.has(question.type)) throw new Error(`Unsupported question type ${question.type}`);
    if (raw === undefined || raw === null) return undefined;
    if (question?.type === 'boolean' && typeof raw !== 'boolean') throw new Error(`${id} must be yes/no`);
    if ((question?.type === 'integer' || question?.type === 'decimal' || contextIds.has(id)) && typeof raw !== 'number') {
      throw new Error(`${id} must be a number`);
    }
    if (question?.type === 'select_one') {
      if (typeof raw !== 'string' || !question.options?.some((option) => option.id === raw)) {
        throw new Error(`${id} is not an option`);
      }
    }
    return raw;
  };

  const scope = model.applicability ? evalCondition(model.applicability.when, lookupTri) : 'true';
  const table = model.decisionTables[0];
  if (!table) throw new Error('A logic model needs one decision table');

  const matchedRows: number[] = [];
  let classification = table.otherwise;
  if (scope === 'unknown' && model.applicability) classification = model.applicability.unknownOutcome;
  else if (scope === 'false' && model.applicability) classification = model.applicability.notApplicableOutcome;
  else {
    table.rows.forEach((row, index) => {
      if (evalCondition(row.when, lookupTri) === 'true') matchedRows.push(index);
    });
    const first = matchedRows[0];
    if (first !== undefined) classification = table.rows[first]!.outcome;
  }

  const outcome = model.outcomes.find((item) => item.id === classification);
  if (!outcome) throw new Error(`Classification ${classification} is not an outcome`);
  const days = outcome.followUp?.afterDays;

  const derivedOut: Record<string, 'yes' | 'no' | ''> = {};
  for (const [id, tri] of derived) derivedOut[id] = yn(tri);

  return {
    classification,
    inScope: scope === 'true' ? 'yes' : scope === 'false' ? 'no' : 'unknown',
    referralUrgent: outcome.referral === 'urgent' ? 'yes' : 'no',
    followUpDays: days === undefined ? '' : String(days),
    derived: derivedOut,
    matchedRows,
  };
}

/** Report fields the golden cases compare. Derived ids are included by name. */
export function reportFields(evaluation: Evaluation): Record<string, string> {
  return {
    classification: evaluation.classification,
    in_scope: evaluation.inScope,
    referral_urgent: evaluation.referralUrgent,
    follow_up_days: evaluation.followUpDays,
    ...evaluation.derived,
  };
}
