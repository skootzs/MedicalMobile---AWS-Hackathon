/**
 * Item H: golden cases as an expected-outcome source. Runs the built
 * dist/run.js against the vendored 7f488e6 fixture with the golden file.
 * Requires the build and a python3 >= 3.10; fails (not skips) otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const RUN_JS = join(here, '..', '..', 'dist', 'run.js');

function fixtures(): { project: string; golden: string } {
  const roots = [join(here, 'fixtures'), join(here, '..', '..', 'test', 'fixtures')];
  for (const r of roots) {
    if (existsSync(join(r, 'child-cough-project', 'compile-manifest.json'))) {
      return { project: join(r, 'child-cough-project'), golden: join(r, 'golden-cases.json') };
    }
  }
  return { project: join(roots[1]!, 'child-cough-project'), golden: join(roots[1]!, 'golden-cases.json') };
}

function pythonOk(): boolean {
  try {
    const m = /(\d+)\.(\d+)/.exec(execFileSync('python3', ['--version'], { encoding: 'utf8' }));
    if (!m) return false;
    const [maj, min] = [Number(m[1]), Number(m[2])];
    return maj > 3 || (maj === 3 && min >= 10);
  } catch {
    return false;
  }
}

function runGolden(): { code: number | null; report: Record<string, unknown> } {
  assert.ok(existsSync(RUN_JS), `built runner not found at ${RUN_JS}; run "npm run build" first`);
  assert.ok(pythonOk(), 'python3 >= 3.10 is required on PATH for the golden tests');
  const { project, golden } = fixtures();
  assert.ok(existsSync(golden), `golden file missing at ${golden}`);
  const outDir = mkdtempSync(join(tmpdir(), 'golden-out-'));
  const res = spawnSync(process.execPath, [RUN_JS], {
    env: { ...process.env, CHT_CONFIG_DIR: project, GOLDEN_CASES_FILE: golden, TZ: 'Africa/Nairobi', OUT_DIR: outDir, PATIENTS_FILE: '' },
    encoding: 'utf8',
  });
  const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
  rmSync(outDir, { recursive: true, force: true });
  return { code: res.status, report };
}

// Cache a single run across tests (it is the slow part).
let cached: { code: number | null; report: Record<string, unknown> } | null = null;
function golden(): { code: number | null; report: Record<string, unknown> } {
  if (!cached) cached = runGolden();
  return cached;
}

function goldenCases(report: Record<string, unknown>): Array<Record<string, unknown>> {
  return (report['cases'] as Array<Record<string, unknown>>).filter((c) => String(c['id']).startsWith('golden/'));
}

test('H: golden run records goldenCasesHash and an info note (not a failing check)', () => {
  const { report } = golden();
  assert.match(String(report['goldenCasesHash']), /^[a-f0-9]{64}$/);
  const info = (report['integrityChecks'] as Array<Record<string, unknown>>).find((c) => c['name'] === 'goldenCasesInfo');
  assert.ok(info, 'goldenCasesInfo present');
  assert.equal(info!['ok'], true);
  assert.match(String(info!['detail']), /not clinician-approved/);
});

test('H5: 22 golden cases -> 20 pass, 2 error (blocked), 0 fail', () => {
  const g = goldenCases(golden().report);
  assert.equal(g.length, 22);
  const counts: Record<string, number> = {};
  for (const c of g) counts[String(c['status'])] = (counts[String(c['status'])] ?? 0) + 1;
  assert.equal(counts['pass'], 20);
  assert.equal(counts['error'], 2);
  assert.equal(counts['fail'] ?? 0, 0);
});

test('H3: the two incomplete cases are errors with the blocked-submission reason, not "incomplete"', () => {
  const g = goldenCases(golden().report);
  const blocked = g.filter((c) => String(c['id']).includes('incomplete'));
  assert.equal(blocked.length, 2);
  for (const c of blocked) {
    assert.equal(c['status'], 'error');
    assert.match(String(c['harnessOutput']), /form blocked submission \(required question unanswered\)/);
    // must NOT be classified as "incomplete"
    const actual = c['actual'] as Record<string, unknown> | null;
    assert.notEqual(actual?.['classification'], 'incomplete');
  }
});

test('H: a passing golden case records derived fields read from the report (fast_breathing etc.)', () => {
  const g = goldenCases(golden().report);
  const passing = g.find((c) => c['status'] === 'pass' && String(c['id']).includes('breaths-50-at-2-months'));
  assert.ok(passing, 'expected breaths-50-at-2-months to pass');
  const actual = passing!['actual'] as Record<string, unknown>;
  // The executor recorded the golden-declared derived fields.
  assert.ok('fast_breathing' in actual);
  assert.ok('any_general_danger_sign' in actual);
});

test('H5: exit code is 1 (blocked cases => passed false), with a valid report', () => {
  const { code, report } = golden();
  assert.equal(code, 1);
  assert.equal(report['passed'], false);
});
