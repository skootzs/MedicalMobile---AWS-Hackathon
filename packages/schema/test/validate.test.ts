import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { validateGoldenCases, validateLogicModel } from '../src/validate.ts';

const model = JSON.parse(readFileSync(new URL('../../../fixtures/child-cough/logic.json', import.meta.url), 'utf8'));
const cases = JSON.parse(readFileSync(new URL('../../../fixtures/child-cough/golden-cases.json', import.meta.url), 'utf8'));

describe('LogicModel schema', () => {
  it('accepts the child cough fixture', () => {
    const result = validateLogicModel(model);
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  });

  it('rejects a field the compiler does not know', () => {
    const result = validateLogicModel({ ...model, extra: true });
    assert.equal(result.ok, false);
  });
});

describe('golden case schema', () => {
  it('accepts the shared golden cases', () => {
    const result = validateGoldenCases(cases);
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  });
});
