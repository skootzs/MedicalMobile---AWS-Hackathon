import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { compileLogicModel, diffAgainstBaseline, DIFF_FILE, MANIFEST_FILE, writeCompiledProject } from '../../src/index.ts';

const FIXTURE = new URL('../fixtures/child-cough.logic.json', import.meta.url);
const fixture = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));

function compiled(model: unknown = fixture(), options = {}) {
  const result = compileLogicModel(model, options);
  if (!result.ok) assert.fail(JSON.stringify(result.errors, null, 2));
  return result.artifact;
}

const diff = (before: ReturnType<typeof compiled>, after: ReturnType<typeof compiled>) =>
  diffAgainstBaseline(after, before.manifest, before.xlsForm);

describe('diffAgainstBaseline', () => {
  it('reports nothing for an identical build', () => {
    const d = diff(compiled(), compiled());
    assert.equal(d.identical, true);
    assert.deepEqual(d.survey, { added: [], removed: [], changed: [] });
    assert.deepEqual(d.settings, {});
    assert.deepEqual(d.warnings, []);
    assert.equal(d.tasks, null);
  });

  it('shows a changed threshold as a calculation change, not a new field', () => {
    const model = fixture();
    model.derived[0].when.or[1].and[1].gte[1] = 45;
    const d = diff(compiled(), compiled(model));
    assert.equal(d.identical, false);
    assert.deepEqual(d.survey.added, []);
    assert.deepEqual(d.survey.removed, []);
    const changed = d.survey.changed.find((c) => c.key === 'fast_breathing');
    assert.ok(changed?.columns.calculation, 'fast_breathing calculation should change');
    assert.match(changed.columns.calculation.after, /45/);
    assert.deepEqual(d.settings, {}, 'the version column is ignored');
  });

  it('shows a wording change as a label change only', () => {
    const model = fixture();
    model.questions[1].label = 'Is the child unable to drink or breastfeed?';
    const d = diff(compiled(), compiled(model));
    assert.equal(d.survey.changed.length, 1);
    assert.deepEqual(Object.keys(d.survey.changed[0]!.columns), ['label::en']);
    assert.deepEqual(d.warnings, []);
  });

  it('warns when a question is removed and another added, which may be a rename', () => {
    const model = fixture();
    model.questions[8].id = 'stridor_when_calm';
    model.decisionTables[0].rows.forEach((r: any) => {
      r.when = JSON.parse(JSON.stringify(r.when).replaceAll('stridor_in_calm_child', 'stridor_when_calm'));
    });
    const d = diff(compiled(), compiled(model));
    assert.ok(d.survey.removed.includes('breathing/stridor_in_calm_child'));
    assert.ok(d.survey.added.includes('breathing/stridor_when_calm'));
    assert.ok(d.warnings.some((w) => /Fields removed/.test(w)));
    assert.ok(d.warnings.some((w) => /rename/.test(w)));
  });

  it('reports changed follow-up days and the changed task', () => {
    const model = fixture();
    model.outcomes.find((o: any) => o.id === 'pneumonia').followUp.afterDays = 2;
    const d = diff(compiled(), compiled(model));
    assert.deepEqual(d.outcomes.changed.map((c) => c.id), ['pneumonia']);
  });

  it('is written to compile-diff.json and summarised in the manifest', () => {
    const before = compiled();
    const model = fixture();
    model.questions[1].label = 'Changed label';
    const after = compiled(model);
    const out = join(mkdtempSync(join(tmpdir(), 'r5-diff-')), 'p');
    writeCompiledProject(after, out, { diff: diffAgainstBaseline(after, before.manifest, before.xlsForm) });
    assert.ok(existsSync(join(out, DIFF_FILE)));
    const manifest = JSON.parse(readFileSync(join(out, MANIFEST_FILE), 'utf8'));
    assert.equal(manifest.baseline.artifactHash, before.manifest.artifactHash);
    assert.equal(manifest.baseline.identical, false);
    assert.equal(manifest.baseline.diffFile, DIFF_FILE);
  });

  it('records baseline: null without a baseline', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'r5-diff-')), 'p');
    writeCompiledProject(compiled(), out);
    assert.equal(JSON.parse(readFileSync(join(out, MANIFEST_FILE), 'utf8')).baseline, null);
  });
});
