import type { ErrorList } from './errors.ts';

export type SymbolKind = 'boolean' | 'number' | 'select_one' | 'derived';

export interface SymbolInfo {
  kind: SymbolKind;
  options?: ReadonlySet<string>;
}

export type SymbolTable = ReadonlyMap<string, SymbolInfo>;

// A condition compiles to two XPath expressions. Both are false when the
// condition is unknown (some value it depends on is unanswered).
export interface TriState {
  isTrue: string;
  isFalse: string;
}

const COMPARISONS = { lt: ['<', '>='], lte: ['<=', '>'], gt: ['>', '<='], gte: ['>=', '<'] } as const;
const NODE_KEYS = ['and', 'or', 'not', 'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'answered'] as const;
const OPTION_LITERAL = /^[a-z][a-z0-9_]*$/;

export function ref(id: string): string {
  return `\${${id}}`;
}

export function numberLiteral(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const text = String(value);
  return /^-?\d+(\.\d+)?$/.test(text) ? text : null;
}

export function compileCondition(
  node: unknown,
  symbols: SymbolTable,
  path: string,
  errors: ErrorList,
): TriState | null {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    errors.add('UNSUPPORTED_NODE', path, 'A condition must be an object with exactly one operator key');
    return null;
  }
  const keys = Object.keys(node);
  if (keys.length !== 1 || !(NODE_KEYS as readonly string[]).includes(keys[0]!)) {
    errors.add('UNSUPPORTED_NODE', path, `Unsupported condition ${JSON.stringify(keys)}; supported: ${NODE_KEYS.join(', ')}`);
    return null;
  }
  const op = keys[0] as (typeof NODE_KEYS)[number];
  const arg = (node as Record<string, unknown>)[op];
  const at = `${path}.${op}`;

  if (op === 'and' || op === 'or') {
    if (!Array.isArray(arg) || arg.length === 0) {
      errors.add('INVALID_VALUE', at, `'${op}' needs a non-empty array of conditions`);
      return null;
    }
    const parts = arg.map((child, i) => compileCondition(child, symbols, `${at}[${i}]`, errors));
    if (parts.some((p) => p === null)) return null;
    const ok = parts as TriState[];
    if (ok.length === 1) return ok[0]!;
    const join = (exprs: string[], word: string) => `(${exprs.join(` ${word} `)})`;
    return op === 'and'
      ? { isTrue: join(ok.map((p) => p.isTrue), 'and'), isFalse: join(ok.map((p) => p.isFalse), 'or') }
      : { isTrue: join(ok.map((p) => p.isTrue), 'or'), isFalse: join(ok.map((p) => p.isFalse), 'and') };
  }

  if (op === 'not') {
    const inner = compileCondition(arg, symbols, at, errors);
    return inner && { isTrue: inner.isFalse, isFalse: inner.isTrue };
  }

  if (op === 'answered') {
    const symbol = lookup(arg, symbols, at, errors);
    if (!symbol) return null;
    if (symbol.kind === 'derived') {
      errors.add('TYPE_MISMATCH', at, `'answered' applies to questions and context values, not derived value '${String(arg)}'`);
      return null;
    }
    return { isTrue: `${ref(arg as string)} != ''`, isFalse: `${ref(arg as string)} = ''` };
  }

  if (!Array.isArray(arg) || arg.length !== 2) {
    errors.add('INVALID_VALUE', at, `'${op}' needs [id, literal]`);
    return null;
  }
  const [id, literal] = arg as [unknown, unknown];
  const symbol = lookup(id, symbols, `${at}[0]`, errors);
  if (!symbol) return null;
  const field = ref(id as string);
  const answered = `${field} != ''`;
  const badLiteral = (code: 'TYPE_MISMATCH' | 'UNKNOWN_OPTION', message: string): null => {
    if (typeof literal === 'string' && symbols.has(literal)) {
      errors.add('UNSUPPORTED_NODE', `${at}[1]`, `Comparing '${String(id)}' with another value ('${literal}') is not supported; compare with a literal`);
    } else {
      errors.add(code, `${at}[1]`, message);
    }
    return null;
  };

  if (op === 'eq' || op === 'neq') {
    let match: TriState | null = null;
    if (symbol.kind === 'boolean' || symbol.kind === 'derived') {
      if (typeof literal !== 'boolean') {
        return badLiteral('TYPE_MISMATCH', `'${String(id)}' is yes/no; compare it with true or false`);
      }
      const yes = symbol.kind === 'boolean' ? `selected(${field}, 'yes')` : `${field} = 'yes'`;
      const no = symbol.kind === 'boolean' ? `selected(${field}, 'no')` : `${field} = 'no'`;
      match = literal ? { isTrue: yes, isFalse: no } : { isTrue: no, isFalse: yes };
    } else if (symbol.kind === 'select_one') {
      if (typeof literal !== 'string' || !OPTION_LITERAL.test(literal) || !symbol.options?.has(literal)) {
        return badLiteral('UNKNOWN_OPTION', `${JSON.stringify(literal)} is not an option of '${String(id)}'`);
      }
      const selected = `selected(${field}, '${literal}')`;
      match = { isTrue: selected, isFalse: `(${answered} and not(${selected}))` };
    } else {
      const n = numberLiteral(literal);
      if (n === null) {
        return badLiteral('TYPE_MISMATCH', `'${String(id)}' is numeric; compare it with a finite number written without an exponent`);
      }
      match = { isTrue: `(${answered} and ${field} = ${n})`, isFalse: `(${answered} and ${field} != ${n})` };
    }
    return op === 'eq' ? match : { isTrue: match.isFalse, isFalse: match.isTrue };
  }

  if (symbol.kind !== 'number') {
    errors.add('TYPE_MISMATCH', `${at}[0]`, `'${op}' needs a numeric value; '${String(id)}' is ${symbol.kind}`);
    return null;
  }
  const n = numberLiteral(literal);
  if (n === null) {
    return badLiteral('TYPE_MISMATCH', `'${op}' needs a finite number written without an exponent`);
  }
  const [yes, no] = COMPARISONS[op];
  return { isTrue: `(${answered} and ${field} ${yes} ${n})`, isFalse: `(${answered} and ${field} ${no} ${n})` };
}

function lookup(id: unknown, symbols: SymbolTable, path: string, errors: ErrorList): SymbolInfo | null {
  if (typeof id !== 'string') {
    errors.add('INVALID_VALUE', path, 'Expected an id string');
    return null;
  }
  const symbol = symbols.get(id);
  if (!symbol) {
    errors.add('UNKNOWN_REFERENCE', path, `'${id}' is not defined, or is not visible from here`);
    return null;
  }
  return symbol;
}

export function triStateCalculation(condition: TriState): string {
  return `if(${condition.isTrue}, 'yes', if(${condition.isFalse}, 'no', ''))`;
}
