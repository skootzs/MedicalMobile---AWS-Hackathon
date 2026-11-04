/**
 * Item G: the runner inside R7's verify stage. These spawn the BUILT
 * dist/run.js as a child process. They require the build to have run
 * (dist/run.js, dist/data/patients.json) and a python3 >= 3.10 on PATH; if a
 * prerequisite is missing the test FAILS with a clear message (no silent skip).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
// dist-test/test -> package root -> dist/run.js
const DIST = join(here, '..', '..', 'dist');
const RUN_JS = join(DIST, 'run.js');
const BUNDLED_PATIENTS = join(DIST, 'data', 'patients.json');

function fixtureProject(): string {
  const candidates = [join(here, 'fixtures', 'child-cough-project'), join(here, '..', '..', 'test', 'fixtures', 'child-cough-project')];
  for (const c of candidates) if (existsSync(join(c, 'compile-manifest.json'))) return c;
  return candidates[1]!;
}

function pythonOk(): boolean {
  try {
    const out = execFileSync('python3', ['--version'], { encoding: 'utf8' }).trim();
    const m = /(\d+)\.(\d+)/.exec(out);
    if (!m) return false;
    const [maj, min] = [Number(m[1]), Number(m[2])];
    return maj > 3 || (maj === 3 && min >= 10);
  } catch {
    return false;
  }
}

function requireBuilt(): void {
  assert.ok(existsSync(RUN_JS), `built runner not found at ${RUN_JS}; run "npm run build" first`);
  assert.ok(pythonOk(), 'python3 >= 3.10 is required on PATH for the verify-stage tests');
}

function readonlyCopyOf(src: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ro-project-'));
  cpSync(src, dir, { recursive: true });
  // chmod -R a-w
  const walk = (p: string) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const n of readdirSync(p)) walk(join(p, n));
      chmodSync(p, 0o555);
    } else {
      chmodSync(p, 0o444);
    }
  };
  walk(dir);
  return dir;
}

function makeWritable(dir: string): void {
  const walk = (p: string) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      chmodSync(p, 0o755);
      for (const n of readdirSync(p)) walk(join(p, n));
    } else {
      chmodSync(p, 0o644);
    }
  };
  walk(dir);
}

interface RunOpts {
  env: Record<string, string | undefined>;
  nodePath?: string;
  cwd?: string;
}

function runBuilt(opts: RunOpts): { code: number | null; outDir: string } {
  const outDir = mkdtempSync(join(tmpdir(), 'verify-out-'));
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env, OUT_DIR: outDir };
  if (opts.nodePath !== undefined) env['NODE_PATH'] = opts.nodePath;
  const res = spawnSync(process.execPath, [RUN_JS], { env, cwd: opts.cwd, encoding: 'utf8' });
  return { code: res.status, outDir };
}

// G2: bundled patients fallback.
test('G2: with no PATIENTS_FILE, the bundled dist/data/patients.json is used', () => {
  requireBuilt();
  assert.ok(existsSync(BUNDLED_PATIENTS), `bundled patients not found at ${BUNDLED_PATIENTS}; check build step bundle:data`);
  const { code, outDir } = runBuilt({ env: { CHT_CONFIG_DIR: fixtureProject(), TZ: 'Africa/Nairobi', PATIENTS_FILE: undefined } });
  try {
    assert.equal(existsSync(join(outDir, 'report.json')), true);
    const rep = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
    // non-zero cases proves the bundled set was loaded
    assert.ok(rep.cases.length > 0, 'bundled patient set should yield cases');
    const log = readFileSync(join(outDir, 'verification.log'), 'utf8');
    assert.match(log, /using bundled patient set/);
    assert.equal(code, 1); // no expected source => passed false
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// G3: harness resolved via NODE_PATH only (no node_modules next to dist).
test('G3: harness loads via NODE_PATH with no node_modules beside dist', () => {
  requireBuilt();
  // Stage a dist copy in a temp dir with NO node_modules, point NODE_PATH at
  // the real node_modules.
  const stage = mkdtempSync(join(tmpdir(), 'dist-stage-'));
  try {
    cpSync(DIST, join(stage, 'dist'), { recursive: true });
    assert.equal(existsSync(join(stage, 'node_modules')), false, 'staged dist must have no sibling node_modules');
    const realNodeModules = join(here, '..', '..', 'node_modules');
    const outDir = mkdtempSync(join(tmpdir(), 'g3-out-'));
    const res = spawnSync(process.execPath, [join(stage, 'dist', 'run.js')], {
      env: { ...process.env, CHT_CONFIG_DIR: fixtureProject(), TZ: 'Africa/Nairobi', OUT_DIR: outDir, NODE_PATH: realNodeModules },
      encoding: 'utf8',
    });
    try {
      assert.equal(existsSync(join(outDir, 'report.json')), true, `report.json not written; stderr: ${res.stderr}`);
      assert.equal(res.status, 1);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

// G4: read-only project, HOME unset and HOME=/tmp; report writes into project.
function assertNoWritesIntoProject(home: string | undefined): void {
  const ro = readonlyCopyOf(fixtureProject());
  const before = snapshot(ro);
  const { code, outDir } = runBuilt({ env: { CHT_CONFIG_DIR: ro, TZ: 'Africa/Nairobi', HOME: home } });
  try {
    const after = snapshot(ro);
    assert.deepEqual(after, before, `the runner must not write into the read-only project dir (HOME=${String(home)})`);
    // It should still produce a report (read-only project is fine for us).
    assert.equal(existsSync(join(outDir, 'report.json')), true, `report.json expected even with read-only project (HOME=${String(home)})`);
    assert.equal(code, 1);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    makeWritable(ro);
    rmSync(ro, { recursive: true, force: true });
  }
}

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const n of readdirSync(join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${n}` : n;
      const st = statSync(join(dir, r));
      if (st.isDirectory()) walk(r);
      else out.push(`${r}:${st.size}`);
    }
  };
  walk('');
  return out.sort();
}

test('G4: read-only project, HOME unset => no writes into the project dir', () => {
  requireBuilt();
  assertNoWritesIntoProject(undefined);
});

test('G4: read-only project, HOME=/tmp => no writes into the project dir', () => {
  requireBuilt();
  assertNoWritesIntoProject('/tmp');
});
