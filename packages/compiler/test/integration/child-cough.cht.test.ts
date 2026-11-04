import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { compileLogicModel, writeCompiledProject } from '../../src/index.ts';

// Set CHT_BIN to the cht-conf binary if it is not on PATH.
const CHT = process.env.CHT_BIN ?? 'cht';
const OUT = fileURLToPath(new URL('../../.out/integration/', import.meta.url));
const FIXTURE = new URL('../fixtures/child-cough.logic.json', import.meta.url);
const REFERENCE_ROWS = new URL('../../reference/child-cough/child_cough.rows.json', import.meta.url);
const WATERMARK = 'DEMONSTRATION ONLY. Not clinician-approved. Not for patient care.';

const chtVersion = spawnSync(CHT, ['--version'], { encoding: 'utf8' });
const chtMissing = chtVersion.error || chtVersion.status !== 0
  ? `cht-conf not runnable as '${CHT}' (set CHT_BIN): ${chtVersion.error?.message ?? chtVersion.stderr}`
  : false;

// Set REQUIRE_CHT=1 in CI so a missing toolchain fails instead of skipping.
it('cht-conf is available', (t) => {
  if (!chtMissing) return;
  if (process.env.REQUIRE_CHT === '1') assert.fail(chtMissing);
  t.skip(chtMissing);
});

function buildAndConvert(name: string) {
  const result = compileLogicModel(JSON.parse(readFileSync(FIXTURE, 'utf8')), { watermark: WATERMARK });
  if (!result.ok) assert.fail(JSON.stringify(result.errors, null, 2));
  const dir = `${OUT}${name}`;
  rmSync(dir, { recursive: true, force: true });
  writeCompiledProject(result.artifact, dir);
  const run = spawnSync(
    CHT,
    ['--local', '--skip-dependency-check', '--skip-git-check', 'convert-app-forms', 'validate-app-forms', '--', 'child_cough'],
    { cwd: dir, encoding: 'utf8' },
  );
  const xmlPath = `${dir}/forms/app/child_cough.xml`;
  return { artifact: result.artifact, run, xmlPath, xml: existsSync(xmlPath) ? readFileSync(xmlPath, 'utf8') : '' };
}

describe('child cough fixture through cht-conf', { skip: chtMissing }, () => {
  const first = buildAndConvert('run-1');

  it('converts and validates with cht-conf (exit 0, no ERROR lines)', () => {
    const log = `${first.run.stdout}\n${first.run.stderr}`;
    assert.equal(first.run.status, 0, log);
    assert.doesNotMatch(log, /ERROR/, log);
    assert.match(log, /convert-app-forms complete/);
    assert.match(log, /validate-app-forms complete/);
    assert.ok(first.xml.length > 0, 'no XForm was written');
  });

  it('produces an XForm with the expected id, version and output fields', () => {
    assert.match(first.xml, new RegExp(`<data id="child_cough" version="v1_${first.artifact.manifest.inputHash.slice(0, 12)}"`));
    for (const field of ['patient_uuid', 'in_scope', 'fast_breathing', 'any_general_danger_sign', 'classification',
      'referral_urgent', 'follow_up_days', 't_follow_up_date']) {
      assert.match(first.xml, new RegExp(`<bind nodeset="/data/${field}"[^>]*calculate=`), field);
    }
    for (const outcome of first.artifact.manifest.outcomes) {
      assert.match(first.xml, new RegExp(`<bind nodeset="/data/summary/outcome_${outcome.id}"`), outcome.id);
    }
  });

  it('asks the same questions as the handwritten reference form', () => {
    const reference = JSON.parse(readFileSync(REFERENCE_ROWS, 'utf8'));
    const asked = (rows: { type: string; name: string }[]) =>
      rows.filter((r) => /^(select_one|integer|decimal)/.test(r.type)).map((r) => `${r.name}:${r.type}`).sort();
    assert.deepEqual(asked(first.artifact.xlsForm.survey.rows as never), asked(reference.survey));
  });

  it('gives an identical XForm on a second build', () => {
    const second = buildAndConvert('run-2');
    assert.equal(second.run.status, 0);
    assert.equal(second.artifact.manifest.artifactHash, first.artifact.manifest.artifactHash);
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    assert.equal(hash(second.xml), hash(first.xml));
  });
});
