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
    // PATIENTS_FILE pointed at the golden file would be wrong; set it empty so
    // only the bundled patient set + golden cases run. CHT_CONF_VERSION makes
    // toolVersionsKnown deterministic regardless of whether `cht` is on PATH.
    env: { ...process.env, CHT_CONFIG_DIR: project, GOLDEN_CASES_FILE: golden, TZ: 'Africa/Nairobi', OUT_DIR: outDir, PATIENTS_FILE: '', CHT_CONF_VERSION: '6.6.1' },
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

test('J4/H5: 22 golden cases -> 22 pass, 0 error, 0 fail (incomplete via blocked submission)', () => {
  const g = goldenCases(golden().report);
  assert.equal(g.length, 22);
  const counts: Record<string, number> = {};
  for (const c of g) counts[String(c['status'])] = (counts[String(c['status'])] ?? 0) + 1;
  assert.equal(counts['pass'], 22);
  assert.equal(counts['error'] ?? 0, 0);
  assert.equal(counts['fail'] ?? 0, 0);
});

test('J2/J4: the two incomplete cases pass via matchedBy form-blocked-submission', () => {
  const g = goldenCases(golden().report);
  const blocked = g.filter((c) => String(c['id']).includes('incomplete'));
  assert.equal(blocked.length, 2);
  for (const c of blocked) {
    assert.equal(c['status'], 'pass');
    assert.equal(c['matchedBy'], 'form-blocked-submission');
    assert.equal(c['blockedSubmission'], true);
    assert.match(String(c['harnessOutput']), /form blocked submission \(required question unanswered\)/);
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

test('exit code is 1 and passed false: the bundled synth patients have no source (error)', () => {
  const { code, report } = golden();
  assert.equal(code, 1);
  assert.equal(report['passed'], false);
  // All 22 golden cases pass; the non-pass cases are the bundled synth
  // patients, which have no expected-outcome source and are therefore 'error'.
  const cases = report['cases'] as Array<Record<string, unknown>>;
  const nonGoldenBad = cases.filter((c) => !String(c['id']).startsWith('golden/') && c['status'] !== 'pass');
  assert.ok(nonGoldenBad.length > 0);
  assert.ok(nonGoldenBad.every((c) => c['status'] === 'error'));
});
