/**
 * Part 6 / item D: exit-code mapping, run against the real compiled run.js as a
 * child process. Self-contained: the fixture project and patients file are
 * vendored under test/fixtures, and run.js is resolved relative to this test's
 * compiled location. No hand-set env vars.
 *
 * The one external requirement is a python3 >= 3.10 on PATH (cht-conf form
 * tooling needs it, and the runner gates on it). If it is missing or too old,
 * these tests FAIL with a clear message rather than skipping silently.
 *
 * Exit codes: 0 passed, 1 verification failed with a valid report.json,
 * 2 runner error with no report.json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
// Compiled layout: dist-test/test/exit-codes.test.js and dist-test/src/run.js.
const RUN_JS = join(here, '..', 'src', 'run.js');
// Fixtures live beside the TS test source; they are copied into dist-test too
// because tsc only emits .js. Resolve them from the source tree via a stable
// relative path that works from the compiled location.
const FIXTURES = resolveFixtures();

function resolveFixtures(): string {
  // Try next to the compiled test first, then walk up to the package's
  // test/fixtures (source tree), so this works whether or not fixtures were
  // copied into dist-test.
  const candidates = [
    join(here, 'fixtures'),
    join(here, '..', '..', 'test', 'fixtures'),
  ];
  for (const c of candidates) if (existsSync(join(c, 'child-cough-project', 'compile-manifest.json'))) return c;
  return candidates[0]!; // report the primary path in failure messages
}

const CONFIG = join(FIXTURES, 'child-cough-project');
const PATIENTS = join(FIXTURES, 'patients.json');

function pythonOk(): { ok: boolean; detail: string } {
  try {
    const out = execFileSync('python3', ['--version'], { encoding: 'utf8' }).trim();
    const m = /(\d+)\.(\d+)/.exec(out);
    if (!m) return { ok: false, detail: `could not parse python version from "${out}"` };
    const [maj, min] = [Number(m[1]), Number(m[2])];
    const ok = maj > 3 || (maj === 3 && min >= 10);
    return { ok, detail: ok ? out : `${out} is older than 3.10` };
  } catch (e) {
    return { ok: false, detail: `python3 not found: ${String((e as Error).message ?? e)}` };
  }
}

function requirePrereqs(): void {
  assert.ok(existsSync(RUN_JS), `compiled run.js not found at ${RUN_JS}; run "npm run build" first`);
  assert.ok(
    existsSync(join(CONFIG, 'compile-manifest.json')),
    `fixture project missing at ${CONFIG}; expected vendored test/fixtures/child-cough-project`,
  );
  assert.ok(existsSync(PATIENTS), `fixture patients file missing at ${PATIENTS}`);
  const py = pythonOk();
  assert.ok(py.ok, `python3 >= 3.10 is required on PATH for the exit-code tests (${py.detail})`);
}

function run(env: Record<string, string | undefined>): { code: number | null; outDir: string } {
  const outDir = mkdtempSync(join(tmpdir(), 'exit-out-'));
  const res = spawnSync(process.execPath, [RUN_JS], {
    env: { ...process.env, ...env, OUT_DIR: outDir },
    encoding: 'utf8',
  });
  return { code: res.status, outDir };
}

const reportExists = (outDir: string): boolean => existsSync(join(outDir, 'report.json'));

test('exit 2: TZ unset => no report.json', () => {
  requirePrereqs();
  const { code, outDir } = run({ CHT_CONFIG_DIR: CONFIG, TZ: undefined });
  try {
    assert.equal(code, 2);
    assert.equal(reportExists(outDir), false);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('exit 2: invalid TZ => no report.json', () => {
  requirePrereqs();
  const { code, outDir } = run({ CHT_CONFIG_DIR: CONFIG, TZ: 'Not/AZone' });
  try {
    assert.equal(code, 2);
    assert.equal(reportExists(outDir), false);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('exit 2: missing CHT_CONFIG_DIR => no report.json', () => {
  requirePrereqs();
  const { code, outDir } = run({ CHT_CONFIG_DIR: undefined, TZ: 'Africa/Nairobi' });
  try {
    assert.equal(code, 2);
    assert.equal(reportExists(outDir), false);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('exit 2: missing patients file => no report.json', () => {
  requirePrereqs();
  const { code, outDir } = run({
    CHT_CONFIG_DIR: CONFIG,
    TZ: 'Africa/Nairobi',
    PATIENTS_FILE: join(FIXTURES, 'no-such-patients.json'),
  });
  try {
    assert.equal(code, 2);
    assert.equal(reportExists(outDir), false);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('exit 1: valid run with no expected source => passed false, report written', () => {
  requirePrereqs();
  const { code, outDir } = run({ CHT_CONFIG_DIR: CONFIG, TZ: 'Africa/Nairobi', PATIENTS_FILE: PATIENTS });
  try {
    assert.equal(code, 1);
    assert.equal(reportExists(outDir), true);
    const rep = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
    assert.equal(rep.passed, false);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('mismatch path: tampered EXPECTED_SNAPSHOT_HASH => exit 1 + failed logicModelHash check (I2 alias)', () => {
  requirePrereqs();
  // Per I2, EXPECTED_SNAPSHOT_HASH is an alias for LOGIC_MODEL_HASH; both feed
  // the snapshotHash comparison surfaced as the "logicModelHash" check.
  const { code, outDir } = run({
    CHT_CONFIG_DIR: CONFIG,
    TZ: 'Africa/Nairobi',
    PATIENTS_FILE: PATIENTS,
    EXPECTED_SNAPSHOT_HASH: 'definitely-not-the-manifest-hash',
  });
  try {
    assert.equal(code, 1);
    assert.equal(reportExists(outDir), true);
    const rep = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
    const check = rep.integrityChecks.find((c: { name: string }) => c.name === 'logicModelHash');
    assert.ok(check, 'logicModelHash check present');
    assert.equal(check.ok, false);
    assert.equal(rep.passed, false);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
