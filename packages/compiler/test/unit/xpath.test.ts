import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ErrorList } from '../../src/errors.ts';
import { compileCondition, triStateCalculation, type SymbolInfo } from '../../src/xpath.ts';

const symbols = new Map<string, SymbolInfo>([
  ['cough', { kind: 'boolean' }],
  ['rate', { kind: 'number' }],
  ['colour', { kind: 'select_one', options: new Set(['red', 'blue']) }],
  ['danger', { kind: 'derived' }],
]);

function compile(node: unknown) {
  const errors = new ErrorList();
  const result = compileCondition(node, symbols, '$', errors);
  return { result, errors: errors.items };
}

function balanced(expr: string): boolean {
  let depth = 0;
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

describe('compileCondition leaves', () => {
  it('maps a yes/no question to selected() for both true and false', () => {
    assert.deepEqual(compile({ eq: ['cough', true] }).result, {
      isTrue: "selected(${cough}, 'yes')",
      isFalse: "selected(${cough}, 'no')",
    });
    assert.deepEqual(compile({ eq: ['cough', false] }).result, {
      isTrue: "selected(${cough}, 'no')",
      isFalse: "selected(${cough}, 'yes')",
    });
  });

  it('treats an unanswered numeric value as unknown, not false', () => {
    assert.deepEqual(compile({ gte: ['rate', 50] }).result, {
      isTrue: "(${rate} != '' and ${rate} >= 50)",
      isFalse: "(${rate} != '' and ${rate} < 50)",
    });
  });

  it('negates each comparison operator exactly', () => {
    const pairs = { lt: ['<', '>='], lte: ['<=', '>'], gt: ['>', '<='], gte: ['>=', '<'] };
    for (const [op, [yes, no]] of Object.entries(pairs)) {
      const { result } = compile({ [op]: ['rate', 12] });
      assert.equal(result?.isTrue, `(\${rate} != '' and \${rate} ${yes} 12)`);
      assert.equal(result?.isFalse, `(\${rate} != '' and \${rate} ${no} 12)`);
    }
  });

  it('compares derived values against their yes/no calculate output', () => {
    assert.deepEqual(compile({ eq: ['danger', true] }).result, {
      isTrue: "${danger} = 'yes'",
      isFalse: "${danger} = 'no'",
    });
  });

  it('maps a select_one option and keeps "not this option" unknown until answered', () => {
    assert.deepEqual(compile({ eq: ['colour', 'red'] }).result, {
      isTrue: "selected(${colour}, 'red')",
      isFalse: "(${colour} != '' and not(selected(${colour}, 'red')))",
    });
  });

  it('swaps true and false for neq and not', () => {
    const eq = compile({ eq: ['rate', 3] }).result!;
    assert.deepEqual(compile({ neq: ['rate', 3] }).result, { isTrue: eq.isFalse, isFalse: eq.isTrue });
    assert.deepEqual(compile({ not: { eq: ['rate', 3] } }).result, { isTrue: eq.isFalse, isFalse: eq.isTrue });
  });

  it('answered is never unknown', () => {
    assert.deepEqual(compile({ answered: 'rate' }).result, { isTrue: "${rate} != ''", isFalse: "${rate} = ''" });
  });
});

describe('compileCondition combinators', () => {
  it('uses three-valued logic: and is false if any part is false; or is true if any part is true', () => {
    const { result } = compile({ and: [{ eq: ['cough', true] }, { gte: ['rate', 40] }] });
    assert.equal(result?.isTrue, "(selected(${cough}, 'yes') and (${rate} != '' and ${rate} >= 40))");
    assert.equal(result?.isFalse, "(selected(${cough}, 'no') or (${rate} != '' and ${rate} < 40))");

    const or = compile({ or: [{ eq: ['cough', true] }, { gte: ['rate', 40] }] }).result;
    assert.equal(or?.isTrue, "(selected(${cough}, 'yes') or (${rate} != '' and ${rate} >= 40))");
    assert.equal(or?.isFalse, "(selected(${cough}, 'no') and (${rate} != '' and ${rate} < 40))");
  });

  it('keeps brackets balanced and explicit for deeply nested trees', () => {
    const node = {
      or: [
        { and: [{ lt: ['rate', 12] }, { not: { or: [{ eq: ['cough', true] }, { eq: ['danger', false] }] } }] },
        { and: [{ gte: ['rate', 12] }, { eq: ['colour', 'blue'] }] },
      ],
    };
    const { result, errors } = compile(node);
    assert.deepEqual(errors, []);
    assert.ok(balanced(result!.isTrue) && balanced(result!.isFalse));
    assert.ok(result!.isTrue.startsWith('((') && result!.isTrue.includes(') or ('));
  });

  it('unwraps a single-element group', () => {
    assert.deepEqual(compile({ and: [{ eq: ['cough', true] }] }).result, compile({ eq: ['cough', true] }).result);
  });

  it('wraps a tri-state into a yes / no / empty calculation', () => {
    assert.equal(triStateCalculation({ isTrue: 'A', isFalse: 'B' }), "if(A, 'yes', if(B, 'no', ''))");
  });
});

describe('compileCondition rejects unsupported input', () => {
  const cases: [string, unknown, string][] = [
    ['unknown operator', { xor: [] }, 'UNSUPPORTED_NODE'],
    ['two operators in one node', { eq: ['rate', 1], lt: ['rate', 2] }, 'UNSUPPORTED_NODE'],
    ['an expression string', "${rate} > 3", 'UNSUPPORTED_NODE'],
    ['empty and', { and: [] }, 'INVALID_VALUE'],
    ['unknown id', { eq: ['missing', true] }, 'UNKNOWN_REFERENCE'],
    ['comparison with another field', { gte: ['rate', 'cough'] }, 'UNSUPPORTED_NODE'],
    ['string compared with a number field', { gte: ['rate', '50'] }, 'TYPE_MISMATCH'],
    ['exponent literal', { gte: ['rate', 1e21] }, 'TYPE_MISMATCH'],
    ['infinite literal', { gte: ['rate', Infinity] }, 'TYPE_MISMATCH'],
    ['number compared with yes/no', { eq: ['cough', 1] }, 'TYPE_MISMATCH'],
    ['ordering on yes/no', { gt: ['cough', 1] }, 'TYPE_MISMATCH'],
    ['unknown option', { eq: ['colour', 'green'] }, 'UNKNOWN_OPTION'],
    ['option with a quote', { eq: ['colour', "red') or ('1"] }, 'UNKNOWN_OPTION'],
    ['answered on a derived value', { answered: 'danger' }, 'TYPE_MISMATCH'],
    ['wrong arity', { eq: ['rate'] }, 'INVALID_VALUE'],
  ];
  for (const [name, node, code] of cases) {
    it(name, () => {
      const { result, errors } = compile(node);
      assert.equal(result, null);
      assert.ok(errors.some((e) => e.code === code), `expected ${code}, got ${JSON.stringify(errors)}`);
    });
  }

  it('reports every bad leaf in one pass', () => {
    const { errors } = compile({ and: [{ eq: ['missing', true] }, { xor: 1 }, { gte: ['rate', 'x'] }] });
    assert.deepEqual(errors.map((e) => e.code), ['UNKNOWN_REFERENCE', 'UNSUPPORTED_NODE', 'TYPE_MISMATCH']);
  });
});
