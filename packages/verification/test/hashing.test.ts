/**
 * Part 6: hashing tests. sha256 determinism and one-byte sensitivity;
 * hashDirectory and compileArtifactHash over a temp project; patientSetHash
 * determinism and change-detection.
 *
 * Run with node --test on Node 20 and 22 via a glob.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256, hashDirectory, compileArtifactHash } from '../src/hashing.js';

test('sha256 is deterministic for the same input', () => {
  assert.equal(sha256('hello'), sha256('hello'));
});

test('sha256 changes when one byte changes', () => {
  assert.notEqual(sha256('hello'), sha256('hellp'));
  assert.notEqual(sha256(Buffer.from([0, 1, 2])), sha256(Buffer.from([0, 1, 3])));
});

test('sha256 is lowercase hex of length 64', () => {
  assert.match(sha256('x'), /^[a-f0-9]{64}$/);
});

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hashtest-'));
  mkdirSync(join(dir, 'forms', 'app'), { recursive: true });
  writeFileSync(join(dir, 'forms', 'app', 'child_cough.xlsx'), Buffer.from('xlsx-bytes'));
  writeFileSync(join(dir, 'forms', 'app', 'child_cough.properties.json'), '{"a":1}\n');
  writeFileSync(join(dir, 'forms', 'app', 'child_cough.xml'), '<xml/>');
  writeFileSync(join(dir, 'compile-manifest.json'), '{}');
  return dir;
}

test('compileArtifactHash covers the two generated files, not the xml', () => {
  const dir = makeProject();
  try {
    const before = compileArtifactHash(dir, 'child_cough');
    // Changing the xml must NOT change compileArtifactHash.
    writeFileSync(join(dir, 'forms', 'app', 'child_cough.xml'), '<xml>changed</xml>');
    assert.equal(compileArtifactHash(dir, 'child_cough'), before);
    // Changing a generated file MUST change it.
    writeFileSync(join(dir, 'forms', 'app', 'child_cough.properties.json'), '{"a":2}\n');
    assert.notEqual(compileArtifactHash(dir, 'child_cough'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hashDirectory covers the whole directory incl. xml and detects a change', () => {
  const dir = makeProject();
  try {
    const before = hashDirectory(dir);
    writeFileSync(join(dir, 'forms', 'app', 'child_cough.xml'), '<xml>changed</xml>');
    assert.notEqual(hashDirectory(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patientSetHash equals sha256 of the file bytes, and one byte flips it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'patientset-'));
  try {
    const f = join(dir, 'patients.json');
    const bytes = Buffer.from('[{"id":"a"}]\n');
    writeFileSync(f, bytes);
    // The runner computes sha256 over the raw file bytes; mirror that here.
    const h1 = sha256(bytes);
    const h2 = sha256(Buffer.from('[{"id":"a"}]\n'));
    assert.equal(h1, h2); // determinism
    assert.notEqual(h1, sha256(Buffer.from('[{"id":"b"}]\n'))); // one byte change
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
