import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { compileLogicModel, type CompileErrorCode } from '../../src/index.ts';

const FIXTURE = new URL('../fixtures/child-cough.logic.json', import.meta.url);
const fixture = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));

function compiled(model: unknown = fixture(), options = {}) {
  const result = compileLogicModel(model, options);
  if (!result.ok) assert.fail(`expected success, got ${JSON.stringify(result.errors, null, 2)}`);
  return result.artifact;
}

function rejectedWith(mutate: (m: any) => void, code: CompileErrorCode, options = {}) {
  const model = fixture();
  mutate(model);
  const result = compileLogicModel(model, options);
  assert.equal(result.ok, false, 'expected the model to be rejected');
  if (!result.ok) {
    assert.ok(result.errors.some((e) => e.code === code), `expected ${code}, got ${JSON.stringify(result.errors, null, 2)}`);
  }
}

const row = (artifact: ReturnType<typeof compiled>, name: string) => {
  const found = artifact.xlsForm.survey.rows.find((r) => r.name === name);
  assert.ok(found, `no survey row named ${name}`);
  return found;
};

describe('compileLogicModel on the child cough fixture', () => {
  it('produces the CHT form structure: inputs, contact link, pages, calculates and summary', () => {
    const a = compiled();
    const names = a.xlsForm.survey.rows.map((r) => r.name);
    for (const n of ['inputs', 'patient_uuid', 'patient_id', 'patient_age_in_months', 'in_scope', 'intro', 'danger_signs',
      'breathing', 'fast_breathing', 'any_general_danger_sign', 'classification', 'referral_urgent', 'follow_up_days',
      't_follow_up_date', 'summary']) {
      assert.ok(names.includes(n), `missing ${n}`);
    }
    assert.equal(row(a, 'has_cough_or_difficult_breathing').type, 'select_one yes_no');
    assert.equal(row(a, 'breaths_per_minute').type, 'integer');
    assert.equal(row(a, 'breaths_per_minute').constraint, '. >= 0');
    assert.deepEqual(a.xlsForm.settings.rows[0], {
      form_title: 'Child Cough and Fast Breathing (Demo)',
      form_id: 'child_cough',
      version: `v1_${a.manifest.inputHash.slice(0, 12)}`,
      style: 'pages',
      default_language: 'en',
    });
  });

  it('gives every outcome a summary note, so none is silently dropped', () => {
    const a = compiled();
    const model = fixture();
    for (const o of model.outcomes) {
      assert.equal(row(a, `outcome_${o.id}`).relevant, `\${classification} = '${o.id}'`);
      assert.ok(row(a, 'classification').calculation!.includes(`'${o.id}'`), `classification never yields ${o.id}`);
    }
  });

  it('checks applicability before the decision rows, and the rows in order, ending with the catch-all', () => {
    const calc = row(compiled(), 'classification').calculation!;
    assert.ok(calc.startsWith("if(${in_scope} = 'unknown', 'age_unknown', if(${in_scope} = 'no', 'out_of_scope', "));
    const order = ['not_in_pathway', 'severe_pneumonia_or_very_severe_disease', 'pneumonia', 'cough_or_cold', 'incomplete'];
    const positions = order.map((o) => calc.indexOf(`'${o}'`));
    assert.deepEqual([...positions].sort((x, y) => x - y), positions);
    assert.ok(calc.endsWith(", 'incomplete'))))))"));
  });

  it('derives referral and follow-up fields from outcome metadata', () => {
    const a = compiled();
    assert.equal(row(a, 'referral_urgent').calculation, "if(${classification} = 'severe_pneumonia_or_very_severe_disease', 'yes', 'no')");
    assert.equal(row(a, 'follow_up_days').calculation, "if(${classification} = 'pneumonia', 3, if(${classification} = 'cough_or_cold', 5, ''))");
  });

  it('gates every question on applicability', () => {
    const a = compiled();
    assert.equal(row(a, 'has_cough_or_difficult_breathing').relevant, "${in_scope} = 'yes'");
    assert.equal(row(a, 'vomits_everything').relevant, "(${in_scope} = 'yes' and selected(${has_cough_or_difficult_breathing}, 'yes'))");
    assert.equal(row(a, 'intro').relevant, undefined);
    assert.equal(row(a, 'danger_signs').relevant, row(a, 'vomits_everything').relevant);
  });

  it('adds the watermark to the first page and the summary only when asked', () => {
    assert.equal(compiled().xlsForm.survey.rows.some((r) => r.name === 'watermark_note'), false);
    const a = compiled(fixture(), { watermark: 'DEMONSTRATION ONLY' });
    assert.equal(row(a, 'watermark_note')['label::en'], '<span style="color:red">DEMONSTRATION ONLY</span>');
    assert.ok(row(a, 'summary_watermark_note'));
  });

  it('lists open, non-blocking ambiguities in the manifest', () => {
    assert.deepEqual(compiled().manifest.openAmbiguities.map((a) => a.id), ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']);
  });

  it('records the snapshot hash it was given, and nothing else is invented', () => {
    assert.equal(compiled().manifest.snapshotHash, null);
    assert.equal(compiled(fixture(), { snapshotHash: 'sha256:abc12345' }).manifest.snapshotHash, 'sha256:abc12345');
  });
});

describe('determinism', () => {
  it('gives byte-identical files and the same hashes for the same input', () => {
    const a = compiled();
    const b = compiled();
    assert.equal(a.manifest.artifactHash, b.manifest.artifactHash);
    assert.deepEqual(a.files.map((f) => Buffer.from(f.bytes).toString('base64')), b.files.map((f) => Buffer.from(f.bytes).toString('base64')));
  });

  it('ignores JSON key order at every level', () => {
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reverseKeys)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]))
          : v;
    const a = compiled(reverseKeys(fixture()));
    const b = compiled();
    assert.equal(a.manifest.inputHash, b.manifest.inputHash);
    assert.equal(a.manifest.artifactHash, b.manifest.artifactHash);
  });

  it('changes the artifact when the logic changes', () => {
    const changed = fixture();
    changed.derived[0].when.or[0].and[1].gte[1] = 51;
    assert.notEqual(compiled(changed).manifest.artifactHash, compiled().manifest.artifactHash);
  });
});

describe('fails closed', () => {
  it('rejects non-object input', () => {
    const result = compileLogicModel('not a model');
    assert.equal(result.ok, false);
  });

  it('rejects an unsupported schema version', () => rejectedWith((m) => { m.schemaVersion = '2.0'; }, 'UNSUPPORTED_SCHEMA_VERSION'));
  it('rejects a second language', () => rejectedWith((m) => { m.language = 'sw'; }, 'UNSUPPORTED_LANGUAGE'));
  it('rejects fields it does not understand instead of ignoring them', () =>
    rejectedWith((m) => { m.questions[0].constraint = '. > 3'; }, 'UNKNOWN_FIELD'));
  it('rejects unknown top-level fields', () => rejectedWith((m) => { m.targets = []; }, 'UNKNOWN_FIELD'));
  it('rejects missing required fields', () => rejectedWith((m) => { delete m.outcomes; }, 'MISSING_FIELD'));
  it('rejects unsupported question types', () => rejectedWith((m) => { m.questions[0].type = 'select_multiple'; }, 'UNSUPPORTED_QUESTION_TYPE'));
  it('rejects unsupported context sources', () => rejectedWith((m) => { m.context[0].from = 'contact.sex'; }, 'UNSUPPORTED_CONTEXT'));
  it('rejects condition strings', () => rejectedWith((m) => { m.derived[0].when = "${breaths_per_minute} >= 50"; }, 'UNSUPPORTED_NODE'));
  it('rejects a reference to an undefined value', () =>
    rejectedWith((m) => { m.decisionTables[0].rows[0].when = { eq: ['cough', false] }; }, 'UNKNOWN_REFERENCE'));
  it('rejects a question whose relevance looks forward to a later question', () =>
    rejectedWith((m) => { m.questions[0].relevantWhen = { eq: ['chest_indrawing', true] }; }, 'UNKNOWN_REFERENCE'));
  it('rejects applicability that depends on answers rather than context', () =>
    rejectedWith((m) => { m.applicability.when = { eq: ['has_cough_or_difficult_breathing', true] }; }, 'UNKNOWN_REFERENCE'));
  it('rejects a decision row pointing at an undefined outcome', () =>
    rejectedWith((m) => { m.decisionTables[0].rows[1].outcome = 'very_severe'; }, 'UNKNOWN_OUTCOME'));
  it('rejects an outcome that nothing can produce', () =>
    rejectedWith((m) => { m.outcomes.push({ id: 'treat_at_home', label: 'Treat at home', referral: 'none' }); }, 'UNREACHABLE_OUTCOME'));
  it('rejects a decision table without a catch-all', () =>
    rejectedWith((m) => { delete m.decisionTables[0].otherwise; }, 'MISSING_FIELD'));
  it('rejects more than one decision table', () =>
    rejectedWith((m) => { m.decisionTables.push(structuredClone(m.decisionTables[0])); }, 'UNSUPPORTED_DECISION_TABLE_COUNT'));
  it('rejects an open blocking ambiguity', () =>
    rejectedWith((m) => { m.ambiguities[0].blocking = true; }, 'OPEN_BLOCKING_AMBIGUITY'));
  it('accepts a resolved blocking ambiguity', () => {
    const m = fixture();
    m.ambiguities[0] = { ...m.ambiguities[0], status: 'resolved', blocking: true, resolution: 'Clinician decision' };
    assert.ok(compileLogicModel(m).ok);
  });
  it('rejects duplicate field names', () => rejectedWith((m) => { m.questions[1].id = m.questions[0].id; }, 'DUPLICATE_ID'));
  it('rejects ids that collide with CHT or compiler fields', () => rejectedWith((m) => { m.derived[0].id = 'patient_id'; }, 'RESERVED_ID'));
  it('rejects ids that are not snake_case', () => rejectedWith((m) => { m.questions[0].id = 'Has-Cough'; }, 'INVALID_ID'));
  it('rejects text that would be read as an XLSForm reference or HTML', () => {
    rejectedWith((m) => { m.questions[0].label = 'Age is ${patient_age_in_months}'; }, 'UNSUPPORTED_TEXT');
    rejectedWith((m) => { m.outcomes[0].message = '<b>Refer</b>'; }, 'UNSUPPORTED_TEXT');
  });
  it('rejects an unknown source reference', () =>
    rejectedWith((m) => { m.questions[0].source.sourceId = 'who_2020'; }, 'UNKNOWN_SOURCE'));
  it('rejects a question on an undeclared page', () => rejectedWith((m) => { m.questions[0].page = 'vitals'; }, 'UNKNOWN_PAGE'));
  it('rejects a declared page with no questions', () =>
    rejectedWith((m) => { m.pages.push({ id: 'vitals', label: 'Vitals' }); }, 'EMPTY_PAGE'));
  it('rejects bounds on non-numeric questions and inverted bounds', () => {
    rejectedWith((m) => { m.questions[0].min = 0; }, 'INVALID_VALUE');
    rejectedWith((m) => { m.questions[6].max = -1; }, 'INVALID_VALUE');
  });
  it('rejects a fractional follow-up', () => rejectedWith((m) => { m.outcomes[1].followUp.afterDays = 2.5; }, 'INVALID_VALUE'));
  it('rejects bad compile options', () => {
    rejectedWith(() => {}, 'INVALID_VALUE', { icon: 'Icon With Spaces' });
    rejectedWith(() => {}, 'UNSUPPORTED_TEXT', { watermark: '<b>demo</b>' });
    rejectedWith(() => {}, 'INVALID_VALUE', { snapshotHash: 'x' });
  });

  it('returns all problems at once and no artifact', () => {
    const m = fixture();
    m.language = 'fr';
    m.questions[0].type = 'text';
    m.decisionTables[0].otherwise = 'nothing';
    const result = compileLogicModel(m);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const codes = result.errors.map((e) => e.code);
      for (const c of ['UNSUPPORTED_LANGUAGE', 'UNSUPPORTED_QUESTION_TYPE', 'UNKNOWN_OUTCOME'] as const) assert.ok(codes.includes(c), c);
      assert.equal('artifact' in result, false);
    }
  });
});
