/**
 * Derive a synthetic patient set from R5's logic model, with NO clinical
 * constants in code. Every numeric boundary, question id, page and type is
 * read from the model. For each numeric literal in a comparison on an integer
 * variable (age or an integer question) we generate the value below, at and
 * above the boundary; booleans get true and false; and we add unanswered cases
 * for required visible questions.
 *
 * The generator decides which inputs to TRY. It never decides outcomes; it
 * writes no expected field.
 */
import { readFileSync } from 'node:fs';
import type { PatientInput } from './patients.js';

type Json = unknown;

export interface ModelQuestion {
  id: string;
  type: string;
  page?: string;
  required?: boolean;
  min?: number;
  options?: Array<{ id?: string } | string>;
  relevantWhen?: Json;
}

export interface LogicModel {
  context?: Array<{ id: string; type: string }>;
  applicability?: { when?: Json };
  pages?: Array<{ id: string; label?: string }>;
  questions?: ModelQuestion[];
  derived?: Array<{ id: string; type: string; when?: Json }>;
  decisionTables?: Array<{ rows?: Array<{ when?: Json }> }>;
}

type Tri = 'true' | 'false' | 'unknown';

/**
 * Minimal three-valued evaluation of a model condition against answers, enough
 * for relevantWhen and applicability (eq/and/or/not plus numeric comparisons).
 * A referenced field that is absent/null -> unknown. No clinical constants.
 */
function evalCondition(node: Json, answers: Record<string, unknown>): Tri {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return 'unknown';
  const obj = node as Record<string, Json>;
  const value = (ref: Json): unknown => (typeof ref === 'string' ? answers[ref] : ref);
  const known = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

  if ('and' in obj && Array.isArray(obj['and'])) {
    const parts = obj['and'].map((n) => evalCondition(n, answers));
    if (parts.includes('false')) return 'false';
    if (parts.includes('unknown')) return 'unknown';
    return 'true';
  }
  if ('or' in obj && Array.isArray(obj['or'])) {
    const parts = obj['or'].map((n) => evalCondition(n, answers));
    if (parts.includes('true')) return 'true';
    if (parts.includes('unknown')) return 'unknown';
    return 'false';
  }
  if ('not' in obj) {
    const r = evalCondition(obj['not'], answers);
    return r === 'true' ? 'false' : r === 'false' ? 'true' : 'unknown';
  }
  for (const op of ['eq', 'lt', 'lte', 'gt', 'gte'] as const) {
    if (op in obj && Array.isArray(obj[op]) && (obj[op] as Json[]).length === 2) {
      const [l, r] = obj[op] as [Json, Json];
      const lv = value(l);
      const rv = value(r);
      if (!known(lv) || !known(rv)) return 'unknown';
      switch (op) {
        case 'eq':
          return lv === rv ? 'true' : 'false';
        case 'lt':
          return (lv as number) < (rv as number) ? 'true' : 'false';
        case 'lte':
          return (lv as number) <= (rv as number) ? 'true' : 'false';
        case 'gt':
          return (lv as number) > (rv as number) ? 'true' : 'false';
        case 'gte':
          return (lv as number) >= (rv as number) ? 'true' : 'false';
      }
    }
  }
  return 'unknown';
}

const NUMERIC_OPS = new Set(['lt', 'lte', 'gt', 'gte', 'eq']);

/**
 * Walk a condition tree, collecting numeric literals keyed by the variable
 * they compare against: { [varId]: Set<number> }. Only comparisons of the form
 * { op: [varId, number] } with a numeric op are collected.
 */
export function collectNumericBoundaries(node: Json, out: Map<string, Set<number>> = new Map()): Map<string, Set<number>> {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) collectNumericBoundaries(n, out);
    return out;
  }
  for (const [key, val] of Object.entries(node as Record<string, Json>)) {
    if (NUMERIC_OPS.has(key) && Array.isArray(val) && val.length === 2 && typeof val[0] === 'string' && typeof val[1] === 'number') {
      const varId = val[0];
      const num = val[1];
      if (!out.has(varId)) out.set(varId, new Set());
      out.get(varId)!.add(num);
    } else {
      collectNumericBoundaries(val, out);
    }
  }
  return out;
}

/** Collect every condition tree in the model (applicability, derived, tables). */
function allConditions(model: LogicModel): Json[] {
  const conds: Json[] = [];
  if (model.applicability?.when) conds.push(model.applicability.when);
  for (const d of model.derived ?? []) if (d.when) conds.push(d.when);
  for (const t of model.decisionTables ?? []) for (const r of t.rows ?? []) if (r.when) conds.push(r.when);
  return conds;
}

/** The age variable id (from context), defaulting to patient_age_in_months. */
function ageVarId(model: LogicModel): string {
  const ctx = (model.context ?? []).find((c) => c.type === 'integer');
  return ctx?.id ?? 'patient_age_in_months';
}

export interface LogicModelPatientSet {
  patients: PatientInput[];
  /** For the report: the boundaries that were walked. */
  boundaries: Record<string, number[]>;
}

/**
 * Generate patients from the model. Deterministic. Question defaults: booleans
 * false, integers at a mid value derived from their own boundaries, cough
 * answered true so downstream pages are visible for in-scope ages.
 */
/** Map a model question id to the PatientInput field name where they differ. */
const QUESTION_TO_FIELD: Record<string, string> = {
  has_cough_or_difficult_breathing: 'hasCoughOrDifficultBreathing',
  breaths_per_minute: 'breathsPerMinute',
  chest_indrawing: 'chestIndrawing',
  stridor_in_calm_child: 'stridorInCalmChild',
};

export function generateFromLogicModel(model: LogicModel): LogicModelPatientSet {
  const age = ageVarId(model);
  const questions = model.questions ?? [];

  const boundaryMap = new Map<string, Set<number>>();
  for (const c of allConditions(model)) collectNumericBoundaries(c, boundaryMap);

  const ageBoundaries = [...(boundaryMap.get(age) ?? new Set<number>())].sort((a, b) => a - b);
  const integerQuestions = questions.filter((q) => q.type === 'integer').map((q) => q.id);
  const breathVar = integerQuestions[0];
  const breathBoundaries = breathVar ? [...(boundaryMap.get(breathVar) ?? new Set<number>())].sort((a, b) => a - b) : [];

  const midAge = ageBoundaries.length > 0 ? ageBoundaries[Math.floor(ageBoundaries.length / 2)]! : 24;
  const inRangeAge = ageBoundaries.length >= 1 ? ageBoundaries[0]! : midAge;

  // Neutral value for a question, derived from the model (no clinical constants).
  const neutral = (q: ModelQuestion): unknown => {
    if (q.type === 'boolean') return false;
    if (q.type === 'integer') {
      const bs = boundaryMap.get(q.id);
      if (typeof q.min === 'number') return q.min;
      // a non-boundary value: one below the lowest boundary if any, else 0.
      if (bs && bs.size > 0) return Math.min(...bs) - 1;
      return 0;
    }
    if (q.type.startsWith('select') && q.options && q.options.length > 0) {
      const first = q.options[0]!;
      return typeof first === 'string' ? first : first.id ?? '';
    }
    return null;
  };

  /**
   * A complete answers map keyed by MODEL question id: age + every question's
   * neutral value, then the under-test overrides. Visibility is applied after.
   */
  const completeAnswers = (ageMonths: number | null, overrides: Record<string, unknown>): Record<string, unknown> => {
    const a: Record<string, unknown> = {};
    if (ageMonths !== null) a[age] = ageMonths;
    for (const q of questions) a[q.id] = neutral(q);
    for (const [k, v] of Object.entries(overrides)) a[k] = v;
    return a;
  };

  /** Is a question visible given applicability and its relevantWhen? */
  const isVisible = (q: ModelQuestion, a: Record<string, unknown>): boolean => {
    if (model.applicability?.when && evalCondition(model.applicability.when, a) !== 'true') return false;
    if (q.relevantWhen && evalCondition(q.relevantWhen, a) !== 'true') return false;
    return true;
  };

  /**
   * Blank every non-visible question so no hidden question carries an answer.
   * Iterate to a fixpoint because relevantWhen can chain. Returns the pruned map.
   */
  const pruneHidden = (a: Record<string, unknown>): Record<string, unknown> => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const q of questions) {
        if (a[q.id] === undefined || a[q.id] === null) continue;
        if (!isVisible(q, a)) {
          a[q.id] = null;
          changed = true;
        }
      }
    }
    return a;
  };

  /** Blank a target question and, transitively, anything that depends on it. */
  const blankWithDependents = (a: Record<string, unknown>, target: string): void => {
    a[target] = null;
    let changed = true;
    while (changed) {
      changed = false;
      for (const q of questions) {
        if (a[q.id] === undefined || a[q.id] === null) continue;
        if (q.relevantWhen && evalCondition(q.relevantWhen, a) !== 'true') {
          a[q.id] = null;
          changed = true;
        }
      }
    }
  };

  const out: PatientInput[] = [];
  const ids = new Set<string>();

  /** Translate a model-keyed answers map into a PatientInput. */
  const toPatient = (id: string, kind: PatientInput['kind'], ageMonths: number | null, a: Record<string, unknown>): PatientInput => {
    const p: Record<string, unknown> = { id, kind, targetBranch: null, ageMonths, breathsPerMinute: null, hasCoughOrDifficultBreathing: null };
    for (const q of questions) {
      const field = QUESTION_TO_FIELD[q.id] ?? q.id;
      p[field] = a[q.id] ?? null;
    }
    return p as unknown as PatientInput;
  };

  const push = (id: string, kind: PatientInput['kind'], ageMonths: number | null, overrides: Record<string, unknown>, opts: { blank?: string } = {}): void => {
    if (ids.has(id)) return;
    ids.add(id);
    const a = completeAnswers(ageMonths, overrides);
    if (opts.blank) blankWithDependents(a, opts.blank);
    pruneHidden(a);
    out.push(toPatient(id, kind, ageMonths, a));
  };

  // Age boundaries: below / at / above each (neutral answers otherwise).
  for (const v of ageBoundaries) {
    push(`age/${v - 1}m`, 'boundary', v - 1, {});
    push(`age/${v}m`, 'boundary', v, {});
    push(`age/${v + 1}m`, 'boundary', v + 1, {});
  }

  // Integer-question (breaths) boundaries, at a representative in-range age,
  // with cough answered so the question is visible.
  if (breathVar) {
    for (const v of breathBoundaries) {
      for (const [label, val] of [['below', v - 1], ['at', v], ['above', v + 1]] as const) {
        push(`${breathVar}/${val}/${label}`, 'boundary', inRangeAge, { has_cough_or_difficult_breathing: true, [breathVar]: val });
      }
    }
  }

  // Boolean questions: true and false, in-range age, cough true so downstream
  // questions are visible (cough's own true/false cases set it directly).
  for (const q of questions.filter((x) => x.type === 'boolean')) {
    push(`bool/${q.id}/true`, 'branch', inRangeAge, { has_cough_or_difficult_breathing: true, [q.id]: true });
    push(`bool/${q.id}/false`, 'branch', inRangeAge, { has_cough_or_difficult_breathing: true, [q.id]: false });
  }

  // Unanswered cases: blank the target AND its transitive dependents so no
  // hidden question has an answer.
  push('unanswered/has_cough_or_difficult_breathing', 'exceptional', inRangeAge, { has_cough_or_difficult_breathing: true }, { blank: 'has_cough_or_difficult_breathing' });
  if (breathVar) push(`unanswered/${breathVar}`, 'exceptional', inRangeAge, { has_cough_or_difficult_breathing: true }, { blank: breathVar });

  // Self-assertion (K2): no patient answers a hidden question, and every
  // non-"unanswered" patient answers all visible questions.
  for (const p of out) {
    const rec = p as unknown as Record<string, unknown>;
    const a: Record<string, unknown> = {};
    if (typeof rec['ageMonths'] === 'number') a[age] = rec['ageMonths'];
    for (const q of questions) a[q.id] = rec[QUESTION_TO_FIELD[q.id] ?? q.id] ?? null;
    for (const q of questions) {
      const answered = a[q.id] !== null && a[q.id] !== undefined;
      if (answered && !isVisible(q, a)) {
        throw new Error(`generator bug: patient ${p.id} answers hidden question ${q.id}`);
      }
      if (!p.id.startsWith('unanswered/') && isVisible(q, a) && !answered) {
        throw new Error(`generator bug: patient ${p.id} leaves visible question ${q.id} unanswered`);
      }
    }
  }

  const boundaries: Record<string, number[]> = { [age]: ageBoundaries };
  if (breathVar) boundaries[breathVar] = breathBoundaries;
  return { patients: out, boundaries };
}

export function loadLogicModel(path: string): LogicModel {
  return JSON.parse(readFileSync(path, 'utf8')) as LogicModel;
}
