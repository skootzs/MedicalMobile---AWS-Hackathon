/**
 * Item D change 2: guard that test/fixtures/patients.json stays in sync with
 * the synth-generated patient set.
 *
 * This package does not depend on @cht-nocode/synth, so rather than import and
 * re-run the generator (which would require a cross-package build), we compare
 * the vendored fixture against synth's committed, generated output file
 * (packages/synth/data/patients.json). That file IS the generator's
 * deterministic output. If it is missing we FAIL with an explicit message
 * (no silent skip) explaining how to regenerate it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function findFixture(): string {
  const candidates = [join(here, 'fixtures', 'patients.json'), join(here, '..', '..', 'test', 'fixtures', 'patients.json')];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[1]!;
}

function findSynthData(): string {
  // From test/fixtures (source tree) up to packages/, then synth/data.
  return join(here, '..', '..', '..', 'synth', 'data', 'patients.json');
}

test('fixtures/patients.json matches synth\'s generated patients.json', () => {
  const fixturePath = findFixture();
  const synthPath = findSynthData();

  assert.ok(existsSync(fixturePath), `vendored fixture missing at ${fixturePath}`);
  assert.ok(
    existsSync(synthPath),
    `synth generated patients not found at ${synthPath}. Regenerate it with ` +
      '`node packages/synth/dist/write-patients.js` (after building synth) and re-copy it to ' +
      'packages/verification/test/fixtures/patients.json.',
  );

  const fixture = readFileSync(fixturePath, 'utf8');
  const synth = readFileSync(synthPath, 'utf8');
  assert.equal(
    fixture,
    synth,
    'test/fixtures/patients.json is out of date with packages/synth/data/patients.json. ' +
      'Re-copy the synth output into the fixture.',
  );
});

test('fixtures/patients.json has no expected-outcome fields', () => {
  const fixturePath = findFixture();
  const patients = JSON.parse(readFileSync(fixturePath, 'utf8')) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(patients) && patients.length > 0, 'fixture must be a non-empty array');
  for (const p of patients) {
    assert.ok(!('expected' in p), `patient ${String(p['id'])} must not carry an expected outcome`);
  }
});
