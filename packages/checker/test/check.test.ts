import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { checkLogicModel } from '../src/check.ts';

const model = JSON.parse(readFileSync(new URL('../../../fixtures/child-cough/logic.json', import.meta.url), 'utf8'));
const cases = JSON.parse(readFileSync(new URL('../../../fixtures/child-cough/golden-cases.json', import.meta.url), 'utf8'));

describe('check the child cough fixture', () => {
  it('passes with info findings and no blocking error', () => {
    const result = checkLogicModel(model, cases);
    assert.equal(result.outcome, 'PASS', JSON.stringify(result.findings, null, 2));
    assert.equal(result.findings.some((item) => item.blocking), false);
    assert.ok(result.findings.some((item) => item.code === 'NOT_CLINICAL_APPROVAL'));
    assert.ok(result.findings.some((item) => item.code === 'NO_OVERLAP_ON_BOUNDARY'));
  });

  it('fails a golden case that names the wrong outcome', () => {
    const wrong = structuredClone(cases);
    wrong[4].expected.classification = 'pneumonia';
    const result = checkLogicModel(model, wrong);
    assert.equal(result.outcome, 'FAIL');
    assert.ok(result.findings.some((item) => item.code === 'GOLDEN_MISMATCH' && item.blocking));
  });

  it('fails an open blocking ambiguity', () => {
    const copy = structuredClone(model);
    copy.ambiguities[0].blocking = true;
    const result = checkLogicModel(copy, cases);
    assert.equal(result.outcome, 'FAIL');
    assert.ok(result.findings.some((item) => item.code === 'BLOCKING_AMBIGUITY'));
  });

  it('fails a unique table once two rows match one input', () => {
    const copy = structuredClone(model);
    copy.decisionTables[0].rows.push(structuredClone(copy.decisionTables[0].rows[0]));
    const result = checkLogicModel(copy, []);
    assert.equal(result.outcome, 'FAIL');
    assert.ok(result.findings.some((item) => item.code === 'OVERLAP'));
  });
});
