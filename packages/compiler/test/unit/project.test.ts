import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { compileLogicModel, MANIFEST_FILE, writeCompiledProject } from '../../src/index.ts';

const FIXTURE = new URL('../fixtures/child-cough.logic.json', import.meta.url);

function artifact() {
  const result = compileLogicModel(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  if (!result.ok) assert.fail(JSON.stringify(result.errors, null, 2));
  return result.artifact;
}

function makeTemplate(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'r5-template-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const freshOut = () => join(mkdtempSync(join(tmpdir(), 'r5-out-')), 'project');
const manifestOf = (out: string) => JSON.parse(readFileSync(join(out, MANIFEST_FILE), 'utf8'));

describe('writeCompiledProject with a template', () => {
  it('copies the template, adds the generated form and records the template hash', () => {
    const template = makeTemplate({
      'app_settings/base_settings.json': '{}\n',
      'resources.json': '{"icon-healthcare":"icon-healthcare.svg"}\n',
      'forms/app/.gitkeep': '',
      'forms/app/other_form.xlsx': 'x',
    });
    const out = freshOut();
    writeCompiledProject(artifact(), out, { template });

    assert.equal(readFileSync(join(out, 'resources.json'), 'utf8'), '{"icon-healthcare":"icon-healthcare.svg"}\n');
    assert.ok(existsSync(join(out, 'app_settings/base_settings.json')));
    assert.ok(existsSync(join(out, 'forms/app/other_form.xlsx')));
    assert.ok(existsSync(join(out, 'forms/app/child_cough.xlsx')));
    assert.ok(existsSync(join(out, 'forms/app/child_cough.properties.json')));
    assert.ok(!existsSync(join(out, 'forms/app/.gitkeep')), '.gitkeep should not be copied');

    const { template: info } = manifestOf(out);
    assert.equal(info.files, 3);
    assert.match(info.hash, /^[0-9a-f]{64}$/);
  });

  it('gives the same template hash for the same template content, and a different one when it changes', () => {
    const files = { 'resources.json': '{}\n', 'app_settings/base_settings.json': '{}\n' };
    const a = freshOut();
    const b = freshOut();
    const c = freshOut();
    writeCompiledProject(artifact(), a, { template: makeTemplate(files) });
    writeCompiledProject(artifact(), b, { template: makeTemplate(files) });
    writeCompiledProject(artifact(), c, { template: makeTemplate({ ...files, 'resources.json': '{"x":1}\n' }) });
    assert.equal(manifestOf(a).template.hash, manifestOf(b).template.hash);
    assert.notEqual(manifestOf(a).template.hash, manifestOf(c).template.hash);
  });

  it('records template: null without a template', () => {
    const out = freshOut();
    writeCompiledProject(artifact(), out);
    assert.equal(manifestOf(out).template, null);
  });

  for (const clash of ['forms/app/child_cough.xlsx', 'forms/app/child_cough.xml', MANIFEST_FILE]) {
    it(`refuses a template that already contains ${clash}, and writes nothing`, () => {
      const template = makeTemplate({ 'resources.json': '{}\n', [clash]: 'stale' });
      const out = freshOut();
      assert.throws(() => writeCompiledProject(artifact(), out, { template }), /already contains generated files/);
      assert.ok(!existsSync(out), 'nothing should be written');
    });
  }

  it('refuses a template with a symlink', () => {
    const template = makeTemplate({ 'resources.json': '{}\n' });
    symlinkSync('/etc/hosts', join(template, 'linked'));
    const out = freshOut();
    assert.throws(() => writeCompiledProject(artifact(), out, { template }), /symlink/);
    assert.ok(!existsSync(out));
  });

  it('refuses a missing template directory', () => {
    assert.throws(() => writeCompiledProject(artifact(), freshOut(), { template: '/nonexistent/template' }), /not a directory/);
  });

  it('never changes the template', () => {
    const template = makeTemplate({ 'resources.json': '{}\n', 'forms/app/.gitkeep': '' });
    writeCompiledProject(artifact(), freshOut(), { template });
    assert.deepEqual(readdirSync(join(template, 'forms/app')), ['.gitkeep']);
  });
});
