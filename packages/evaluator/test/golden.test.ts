import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { Answers } from '../src/conditions.ts';
import { evaluateLogicModel, reportFields } from '../src/evaluate.ts';

const model = JSON.parse(readFileSync(new URL('../../../fixtures/child-cough/logic.json', import.meta.url), 'utf8'));
const cases = JSON.parse(readFileSync(new URL('../../../fixtures/child-cough/golden-cases.json', import.meta.url), 'utf8')) as {
  id: string;
  input: Answers;
  expected: Record<string, string>;
}[];

describe('evaluator against golden cases', () => {
  it('matches every expected report field', () => {
    for (const item of cases) {
      const actual = reportFields(evaluateLogicModel(model, item.input));
      for (const key of Object.keys(item.expected)) {
        assert.equal(actual[key], item.expected[key], `${item.id} ${key}`);
      }
    }
  });

  it('uses the first matching row when two rows are true', () => {
    const copy = structuredClone(model);
    copy.decisionTables[0].rows.push({ ...copy.decisionTables[0].rows[0], outcome: 'cough_or_cold' });
    const evaluation = evaluateLogicModel(copy, { patient_age_in_months: 24, has_cough_or_difficult_breathing: false });
    assert.equal(evaluation.classification, 'not_in_pathway');
    assert.equal(evaluation.matchedRows.length, 2);
  });
});
