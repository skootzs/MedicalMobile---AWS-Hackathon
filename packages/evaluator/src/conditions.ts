// Three-valued conditions. An unanswered value is unknown, not false.
// `and` is false when any part is false. `or` is true when any part is true.
// Otherwise a mix of true and unknown is unknown.

export type Tri = 'true' | 'false' | 'unknown';
export type InputValue = boolean | number | string | null;
export type Answers = Record<string, InputValue>;

export interface ConditionNode {
  [operator: string]: unknown;
}

const OPERATORS = ['and', 'or', 'not', 'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'answered'] as const;

export function evalCondition(node: ConditionNode, lookup: (id: string) => Tri | InputValue | undefined): Tri {
  const keys = Object.keys(node);
  if (keys.length !== 1) throw new Error('A condition must have one operator');
  const op = keys[0]!;
  if (!(OPERATORS as readonly string[]).includes(op)) throw new Error(`Unsupported operator ${op}`);
  const arg = node[op];

  if (op === 'and' || op === 'or') {
    const parts = (arg as ConditionNode[]).map((child) => evalCondition(child, lookup));
    if (op === 'and') {
      if (parts.includes('false')) return 'false';
      if (parts.includes('unknown')) return 'unknown';
      return 'true';
    }
    if (parts.includes('true')) return 'true';
    if (parts.includes('unknown')) return 'unknown';
    return 'false';
  }

  if (op === 'not') {
    const inner = evalCondition(arg as ConditionNode, lookup);
    if (inner === 'unknown') return 'unknown';
    return inner === 'true' ? 'false' : 'true';
  }

  if (op === 'answered') {
    const value = lookup(String(arg));
    return value === undefined || value === null ? 'false' : 'true';
  }

  const [id, literal] = arg as [string, boolean | number | string];
  const value = lookup(id);
  if (value === undefined || value === null) return 'unknown';

  if (op === 'eq' || op === 'neq') {
    const same = value === literal;
    const eq = same ? 'true' : 'false';
    return op === 'eq' ? eq : eq === 'true' ? 'false' : 'true';
  }

  if (typeof value !== 'number' || typeof literal !== 'number') {
    throw new Error(`${op} needs a number for ${id}`);
  }
  const yes =
    op === 'lt' ? value < literal :
    op === 'lte' ? value <= literal :
    op === 'gt' ? value > literal :
    value >= literal;
  return yes ? 'true' : 'false';
}

export function yn(tri: Tri): 'yes' | 'no' | '' {
  if (tri === 'true') return 'yes';
  if (tri === 'false') return 'no';
  return '';
}

/** Every id a condition reads. */
export function referencedIds(node: ConditionNode, into = new Set<string>()): Set<string> {
  const op = Object.keys(node)[0];
  if (!op) return into;
  const arg = node[op];
  if (op === 'and' || op === 'or') {
    for (const child of arg as ConditionNode[]) referencedIds(child, into);
  } else if (op === 'not') {
    referencedIds(arg as ConditionNode, into);
  } else if (op === 'answered') {
    into.add(String(arg));
  } else if (Array.isArray(arg)) {
    into.add(String(arg[0]));
  }
  return into;
}

/** Thresholds used in numeric comparisons of one id, plus one step either side. */
export function boundaryNumbers(node: ConditionNode, id: string, into = new Set<number>()): Set<number> {
  const op = Object.keys(node)[0];
  if (!op) return into;
  const arg = node[op];
  if (op === 'and' || op === 'or') {
    for (const child of arg as ConditionNode[]) boundaryNumbers(child, id, into);
  } else if (op === 'not') {
    boundaryNumbers(arg as ConditionNode, id, into);
  } else if (Array.isArray(arg) && arg[0] === id && typeof arg[1] === 'number' && ['lt', 'lte', 'gt', 'gte', 'eq', 'neq'].includes(op)) {
    const n = arg[1];
    into.add(n - 1);
    into.add(n);
    into.add(n + 1);
  }
  return into;
}
