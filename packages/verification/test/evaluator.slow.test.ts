/**
 * Item E6 (slow, written-not-run here): evaluator end-to-end over the vendored
 * model, plus resolution-order checks. Requires the built dist/run.js, the
 * vendored evaluator, python3 >= 3.10 and jsonschema. Fails (not skips) if the
 * build or python is missing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const PKG = join(here, '..', '..');
const RUN_JS = join(PKG, 'dist', 'run.js');

function fx(): { project: string; golden: string; model: string } {
  const roots = [join(PKG, 'dist-test', 'test', 'fixtures'), join(PKG, 'test', 'fixtures')];
  for (const r of roots) if (existsSync(join(r, 'child-cough-project', 'compile-manifest.json'))) {
    return { project: join(r, 'child-cough-project'), golden: join(r, 'golden-cases.json'), model: join(r, 'child-cough.logic.json') };
  }
  const r = join(PKG, 'test', 'fixtures');
  return { project: join(r, 'child-cough-project'), golden: join(r, 'golden-cases.json'), model: join(r, 'child-cough.logic.json') };
}

function pythonOk(): boolean {
  try {
    const m = /(\d+)\.(\d+)/.exec(execFileSync('python3', ['--version'], { encoding: 'utf8' }));
    if (!m) return false;
    return Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 10);
  } catch {
    return false;
  }
}

function requirePrereqs(): void {
  assert.ok(existsSync(RUN_JS), `built runner not found; run "npm run build"`);
  assert.ok(pythonOk(), 'python3 >= 3.10 required');
}

function run(env: Record<string, string | undefined>): { code: number | null; report: Record<string, unknown> } {
  const outDir = mkdtempSync(join(tmpdir(), 'eval-e2e-'));
  const res = spawnSync(process.execPath, [RUN_JS], { env: { ...process.env, ...env, OUT_DIR: outDir, CHT_CONF_VERSION: '6.6.1' }, encoding: 'utf8' });
  const p = join(outDir, 'report.json');
  const report = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  rmSync(outDir, { recursive: true, force: true });
  return { code: res.status, report };
}

test('E2E: evaluator runs over synthetic + golden; records asOf and evaluator sources', () => {
  requirePrereqs();
  const { project, golden, model } = fx();
  const { report } = run({ CHT_CONFIG_DIR: project, GOLDEN_CASES_FILE: golden, LOGIC_MODEL_FILE: model, TZ: 'Africa/Nairobi', PATIENTS_FILE: '' });
  assert.equal(report['asOf'], '2026-02-15');
  const cases = report['cases'] as Array<Record<string, unknown>>;
  // Synthetic patients now have an evaluator source, so they are no longer
  // bare 'error: no source'. Golden+evaluator cases carry expectedSource "both".
  const withEvaluator = cases.filter((c) => c['expectedSource'] === 'evaluator' || c['expectedSource'] === 'both');
  assert.ok(withEvaluator.length > 0, 'expected evaluator-backed cases');
});

test('E2E: model absent => evaluator skipped, no failure from the evaluator itself', () => {
  requirePrereqs();
  const { project } = fx();
  const { report } = run({ CHT_CONFIG_DIR: project, LOGIC_MODEL_FILE: '', TZ: 'Africa/Nairobi', PATIENTS_FILE: '' });
  // With no model and no golden, synthetic patients stay error (no source).
  const cases = report['cases'] as Array<Record<string, unknown>>;
  assert.ok(cases.every((c) => c['expectedSource'] === undefined));
});
