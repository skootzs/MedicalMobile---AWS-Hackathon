import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { compileLogicModel, TASKS_FILE, TRANSLATIONS_FILE, writeCompiledProject, type CompileOptions } from '../../src/index.ts';

const FIXTURE = new URL('../fixtures/child-cough.logic.json', import.meta.url);
const fixture = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));
const DAY = 24 * 60 * 60 * 1000;

function compiled(model: unknown = fixture(), options: CompileOptions = {}) {
  const result = compileLogicModel(model, options);
  if (!result.ok) assert.fail(JSON.stringify(result.errors, null, 2));
  return result.artifact;
}

const fileText = (a: ReturnType<typeof compiled>, path: string) => {
  const f = a.files.find((x) => x.path === path);
  assert.ok(f, `no generated ${path}`);
  return new TextDecoder().decode(f.bytes);
};

// Minimal stand-in for the CHT nools Utils the task functions use.
const Utils = {
  getField: (report: any, path: string) => path.split('.').reduce((o: any, k) => (o == null ? undefined : o[k]), report.fields),
  addDate: (date: Date, days: number) => {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    d.setHours(0, 0, 0, 0);
    return d;
  },
};

function loadTasks(source: string): any[] {
  const module = { exports: [] as any[] };
  vm.runInNewContext(source, { module, Utils });
  return module.exports;
}

// Objects created inside the vm come from another realm, so compare their JSON.
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('follow-up tasks', () => {
  it('writes tasks.js and a translation for pathways with follow-up outcomes', () => {
    const a = compiled();
    const tasks = loadTasks(fileText(a, TASKS_FILE));
    assert.equal(tasks.length, 1);
    const [task] = tasks;
    assert.equal(task.name, 'child_cough_follow_up');
    assert.equal(task.appliesTo, 'reports');
    assert.deepEqual(plain(task.appliesToType), ['child_cough']);
    assert.deepEqual(plain(task.actions), [{ type: 'report', form: 'child_cough' }]);
    assert.equal(task.events[0].start, 0);
    assert.equal(task.events[0].end, 2);
    assert.equal(fileText(a, TRANSLATIONS_FILE), 'task.child_cough.follow_up.title = Follow up: Child Cough and Fast Breathing (Demo)\n');
    assert.deepEqual(a.manifest.tasks?.outcomes, ['pneumonia', 'cough_or_cold']);
    assert.equal(a.manifest.tasks?.windowSource, 'default');
  });

  it('raises the task only when the report has a follow-up date, due on that date', () => {
    const [task] = loadTasks(fileText(compiled(), TASKS_FILE));
    const withDate = { _id: 'r1', form: 'child_cough', reported_date: 0, fields: { t_follow_up_date: '2026-11-07T00:00:00.000Z' } };
    const without = { _id: 'r2', form: 'child_cough', reported_date: 0, fields: { t_follow_up_date: '' } };
    const garbage = { _id: 'r3', form: 'child_cough', reported_date: 0, fields: { t_follow_up_date: 'not a date' } };
    assert.equal(task.appliesIf({}, withDate), true);
    assert.equal(task.appliesIf({}, without), false);
    assert.equal(task.appliesIf({}, garbage), false);
    assert.equal(task.events[0].dueDate(task.events[0], {}, withDate).toISOString(), '2026-11-07T00:00:00.000Z');
  });

  it('is resolved only by a later report of the same form inside the window', () => {
    const [task] = loadTasks(fileText(compiled(), TASKS_FILE));
    const event = task.events[0];
    const due = new Date(2026, 10, 7, 12);
    const first = { _id: 'r1', form: 'child_cough', reported_date: due.getTime() - 3 * DAY, fields: {} };
    const resolves = (reports: any[]) => task.resolvedIf({ reports: [first, ...reports] }, first, event, due);
    assert.equal(resolves([]), false, 'the original report must not resolve its own task');
    assert.equal(resolves([{ _id: 'r2', form: 'child_cough', reported_date: due.getTime() }]), true);
    assert.equal(resolves([{ _id: 'r2', form: 'child_cough', reported_date: due.getTime() + 2 * DAY }]), true);
    assert.equal(resolves([{ _id: 'r2', form: 'child_cough', reported_date: due.getTime() + 4 * DAY }]), false, 'after the window');
    assert.equal(resolves([{ _id: 'r2', form: 'other_form', reported_date: due.getTime() }]), false, 'another form');
  });

  it('uses the task window from the options and records it', () => {
    const a = compiled(fixture(), { taskWindow: { start: 1, end: 5 } });
    const [task] = loadTasks(fileText(a, TASKS_FILE));
    assert.equal(task.events[0].start, 1);
    assert.equal(task.events[0].end, 5);
    assert.deepEqual(a.manifest.tasks?.window, { start: 1, end: 5 });
    assert.equal(a.manifest.tasks?.windowSource, 'option');
  });

  it('rejects an invalid task window', () => {
    const result = compileLogicModel(fixture(), { taskWindow: { start: -1, end: 2.5 } });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.errors.map((e) => e.path).sort(), ['options.taskWindow.end', 'options.taskWindow.start']);
    }
  });

  it('writes no tasks when no outcome has a follow-up', () => {
    const model = fixture();
    for (const o of model.outcomes) delete o.followUp;
    const a = compiled(model);
    assert.ok(!a.files.some((f) => f.path === TASKS_FILE || f.path === TRANSLATIONS_FILE));
    assert.equal(a.manifest.tasks, null);
  });

  it('includes tasks.js in the artifact hash and is deterministic', () => {
    const a = compiled();
    const b = compiled();
    assert.equal(a.manifest.artifactHash, b.manifest.artifactHash);
    assert.deepEqual(a.files.map((f) => f.sha256), b.files.map((f) => f.sha256));
    assert.notEqual(a.manifest.artifactHash, compiled(fixture(), { taskWindow: { start: 0, end: 3 } }).manifest.artifactHash);
  });
});

describe('writing tasks into a template', () => {
  function template(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'r5-tpl-'));
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), t);
    }
    return root;
  }
  const out = () => join(mkdtempSync(join(tmpdir(), 'r5-out-')), 'p');

  it('appends generated translation keys to the template file', () => {
    const dir = out();
    writeCompiledProject(compiled(), dir, { template: template({ [TRANSLATIONS_FILE]: 'existing.key = Hello' }) });
    assert.equal(
      readFileSync(join(dir, TRANSLATIONS_FILE), 'utf8'),
      'existing.key = Hello\ntask.child_cough.follow_up.title = Follow up: Child Cough and Fast Breathing (Demo)\n',
    );
  });

  it('refuses a template that already defines a generated translation key', () => {
    const dir = out();
    const tpl = template({ [TRANSLATIONS_FILE]: 'task.child_cough.follow_up.title = Old\n' });
    assert.throws(() => writeCompiledProject(compiled(), dir, { template: tpl }), /already defines generated keys/);
  });

  it('refuses a template that has its own tasks.js', () => {
    const tpl = template({ [TASKS_FILE]: 'module.exports = [];\n' });
    assert.throws(() => writeCompiledProject(compiled(), out(), { template: tpl }), /already contains generated files: tasks\.js/);
  });
});
