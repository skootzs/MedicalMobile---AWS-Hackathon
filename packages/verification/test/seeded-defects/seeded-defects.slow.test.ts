/**
 * Item S: seeded-defect tests. Proof that the verifier catches bugs.
 *
 * SEEDED DEFECT, NOT RELEASE EVIDENCE. Every fault here is applied to a
 * TEMPORARY COPY of the fixture / patient set / golden file; the committed
 * files are never modified. Each test asserts the SPECIFIC detection, not just
 * passed:false.
 *
 * Slow suite: starts the real runner and Chromium. Requires the build and a
 * python3 >= 3.10 on PATH (fails, not skips, otherwise).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const LABEL = 'seeded defect, not release evidence';
const here = dirname(fileURLToPath(import.meta.url));
// dist-test/test/seeded-defects -> package root
const PKG = join(here, '..', '..', '..');
const RUN_JS = join(PKG, 'dist', 'run.js');

function srcFixtures(): { project: string; golden: string; patients: string } {
  const roots = [join(PKG, 'dist-test', 'test', 'fixtures'), join(PKG, 'test', 'fixtures')];
  for (const r of roots) {
    if (existsSync(join(r, 'child-cough-project', 'compile-manifest.json'))) {
      return { project: join(r, 'child-cough-project'), golden: join(r, 'golden-cases.json'), patients: join(r, 'patients.json') };
    }
  }
  const r = join(PKG, 'test', 'fixtures');
  return { project: join(r, 'child-cough-project'), golden: join(r, 'golden-cases.json'), patients: join(r, 'patients.json') };
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

function requirePrereqs(): void {
  assert.ok(existsSync(RUN_JS), `built runner not found at ${RUN_JS}; run "npm run build" first`);
  assert.ok(pythonOk(), 'python3 >= 3.10 is required on PATH for the seeded-defect tests');
}

interface RunResult {
  code: number | null;
  report: Record<string, unknown>;
}

function run(env: Record<string, string | undefined>): RunResult {
  const outDir = mkdtempSync(join(tmpdir(), 'seeded-out-'));
  const res = spawnSync(process.execPath, [RUN_JS], {
    env: { ...process.env, ...env, OUT_DIR: outDir, CHT_CONF_VERSION: '6.6.1' },
    encoding: 'utf8',
  });
  const reportPath = join(outDir, 'report.json');
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {};
  rmSync(outDir, { recursive: true, force: true });
  return { code: res.status, report };
}

function copyProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'seeded-project-'));
  cpSync(srcFixtures().project, dir, { recursive: true });
  return dir;
}

function cases(report: Record<string, unknown>): Array<Record<string, unknown>> {
  return (report['cases'] as Array<Record<string, unknown>>) ?? [];
}

// S1: threshold fault in a COPY of the xml (12-month fast-breathing 40 -> 41).
test(`S1 (${LABEL}): threshold fault fails the 12m/40-breath golden boundary; artifact hash unchanged`, () => {
  requirePrereqs();
  const { golden } = srcFixtures();
  const project = copyProject();
  try {
    const xmlPath = join(project, 'forms', 'app', 'child_cough.xml');
    const xml = readFileSync(xmlPath, 'utf8');
    assert.match(xml, /&gt;= 40/, 'expected the 40-breath threshold in the xml');
    writeFileSync(xmlPath, xml.replace(/&gt;= 40/g, '&gt;= 41'));

    const { code, report } = run({ CHT_CONFIG_DIR: project, GOLDEN_CASES_FILE: golden, TZ: 'Africa/Nairobi', PATIENTS_FILE: '' });
    const g = cases(report).filter((c) => String(c['id']).startsWith('golden/'));
    const failed = g.filter((c) => c['status'] === 'fail').map((c) => String(c['id']));
    // The 40-breath boundary cases now classify as cough_or_cold, not pneumonia.
    assert.ok(failed.includes('golden/breaths-40-at-12-months'), `expected breaths-40-at-12-months to fail; failed=${JSON.stringify(failed)}`);
    assert.ok(failed.includes('golden/breaths-40-at-59-months'), `expected breaths-40-at-59-months to fail; failed=${JSON.stringify(failed)}`);
    assert.equal(report['passed'], false);
    assert.equal(code, 1);

    // Finding: compileArtifactHash is UNCHANGED (the xml is excluded from the
    // artifact hash), so only the behavioural (golden) comparison caught it.
    const unmodified = run({ CHT_CONFIG_DIR: srcFixtures().project, GOLDEN_CASES_FILE: golden, TZ: 'Africa/Nairobi', PATIENTS_FILE: '' });
    assert.equal(report['compileArtifactHash'], unmodified.report['compileArtifactHash'],
      'FINDING: xml change does not alter compileArtifactHash; only golden behaviour detects it');
    const artifactCheck = (report['integrityChecks'] as Array<Record<string, unknown>>).find((c) => c['name'] === 'compileArtifactHash');
    assert.equal(artifactCheck?.['ok'], true, 'compileArtifactHash check still passes despite the xml fault');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// S2: artifact fault in a COPY (tasks.js, then xlsx).
test(`S2 (${LABEL}): a tampered tasks.js fails the compileArtifactHash check`, () => {
  requirePrereqs();
  const project = copyProject();
  try {
    const p = join(project, 'tasks.js');
    writeFileSync(p, readFileSync(p, 'utf8') + '\n// seeded tamper\n');
    const { code, report } = run({ CHT_CONFIG_DIR: project, TZ: 'Africa/Nairobi', PATIENTS_FILE: '' });
    const check = (report['integrityChecks'] as Array<Record<string, unknown>>).find((c) => c['name'] === 'compileArtifactHash');
    assert.equal(check?.['ok'], false);
    assert.match(String(check?.['detail']), /tasks\.js: FAIL/);
    assert.equal(report['passed'], false);
    assert.equal(code, 1);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test(`S2 (${LABEL}): a tampered xlsx fails the compileArtifactHash check`, () => {
  requirePrereqs();
  const project = copyProject();
  try {
    const p = join(project, 'forms', 'app', 'child_cough.xlsx');
    const buf = readFileSync(p);
    buf[0] = buf[0]! ^ 0xff;
    writeFileSync(p, buf);
    const { code, report } = run({ CHT_CONFIG_DIR: project, TZ: 'Africa/Nairobi', PATIENTS_FILE: '' });
    const check = (report['integrityChecks'] as Array<Record<string, unknown>>).find((c) => c['name'] === 'compileArtifactHash');
    assert.equal(check?.['ok'], false);
    assert.match(String(check?.['detail']), /child_cough\.xlsx: FAIL/);
    assert.equal(report['passed'], false);
    assert.equal(code, 1);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// S3: coverage fault - remove EVERY patient that produces the target outcome,
// found by a baseline run (not by name/id), so the target becomes uncovered.
// The target outcome id is read from the manifest (the urgent-referral
// outcome), never hard-coded.
test(`S3 (${LABEL}): removing all patients that reach the target outcome leaves it uncovered`, () => {
  requirePrereqs();
  const { project, patients } = srcFixtures();
  const manifest = JSON.parse(
    readFileSync(join(project, 'compile-manifest.json'), 'utf8'),
  ) as { outcomes: Array<{ id: string; referral?: string }> };
  const target = manifest.outcomes.find((o) => o.referral === 'urgent')?.id;
  assert.ok(target, 'manifest should declare an urgent-referral (severe) outcome');

  const baseDir = mkdtempSync(join(tmpdir(), 'seeded-s3base-'));
  const baseCopy = join(baseDir, 'patients.json');
  const tmpPatients = join(mkdtempSync(join(tmpdir(), 'seeded-patients-')), 'patients.json');
  try {
    const all = JSON.parse(readFileSync(patients, 'utf8')) as Array<Record<string, unknown>>;

    // Baseline run on a temp copy: find every patient whose OBSERVED
    // classification equals the target outcome.
    writeFileSync(baseCopy, JSON.stringify(all, null, 2) + '\n');
    const base = run({ CHT_CONFIG_DIR: project, TZ: 'Africa/Nairobi', PATIENTS_FILE: baseCopy });
    const baseCases = base.report['cases'] as Array<Record<string, unknown>>;
    const producers = new Set(
      baseCases
        .filter((c) => (c['actual'] as Record<string, unknown> | null)?.['classification'] === target)
        .map((c) => String(c['id'])),
    );
    assert.ok(producers.size > 0, `expected some patients to reach ${target} in the baseline`);

    // Remove ALL of them (no golden file), then re-run.
    const kept = all.filter((p) => !producers.has(String(p['id'])));
    assert.equal(kept.length, all.length - producers.size);
    writeFileSync(tmpPatients, JSON.stringify(kept, null, 2) + '\n');

    const { code, report } = run({ CHT_CONFIG_DIR: project, TZ: 'Africa/Nairobi', PATIENTS_FILE: tmpPatients });
    const cov = report['coverage'] as Record<string, unknown>;
    const uncovered = cov['uncoveredBranchIds'] as string[];
    assert.ok(uncovered.includes(target!), `${target} must be listed uncovered`);
    assert.equal(report['coverageComplete'], false);
    assert.equal(report['passed'], false);
    assert.equal(code, 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(dirname(tmpPatients), { recursive: true, force: true });
  }
});

// S4: data fault - a patient answering a hidden question.
test(`S4 (${LABEL}): a patient answering a hidden question is an error, not a pass`, () => {
  requirePrereqs();
  const { project, patients } = srcFixtures();
  const tmpPatients = join(mkdtempSync(join(tmpdir(), 'seeded-hidden-')), 'patients.json');
  try {
    const all = JSON.parse(readFileSync(patients, 'utf8')) as Array<Record<string, unknown>>;
    // cough = no (hides the breathing/danger pages) but answers a danger sign.
    all.push({
      id: 'seeded/no-cough-answers-hidden-question',
      kind: 'exceptional',
      targetBranch: null,
      ageMonths: 24,
      breathsPerMinute: 45,
      hasCoughOrDifficultBreathing: false,
      not_able_to_drink_or_breastfeed: true, // answer to a now-hidden question
      vomits_everything: false,
      had_convulsions: false,
      lethargic_or_unconscious: false,
      convulsing_now: false,
      chestIndrawing: false,
      stridorInCalmChild: false,
    });
    writeFileSync(tmpPatients, JSON.stringify(all, null, 2) + '\n');

    const { code, report } = run({ CHT_CONFIG_DIR: project, TZ: 'Africa/Nairobi', PATIENTS_FILE: tmpPatients });
    const seeded = cases(report).find((c) => c['id'] === 'seeded/no-cough-answers-hidden-question');
    assert.ok(seeded, 'seeded case present in report');
    // No expected source => the case is an error (never a silent pass).
    assert.equal(seeded!['status'], 'error');
    assert.equal(report['passed'], false);
    assert.equal(code, 1);
  } finally {
    rmSync(dirname(tmpPatients), { recursive: true, force: true });
  }
});
