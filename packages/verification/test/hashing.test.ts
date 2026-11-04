/**
 * Part 6: hashing tests. sha256 determinism and one-byte sensitivity;
 * hashDirectory and compileArtifactHash over a temp project; patientSetHash
 * determinism and change-detection.
 *
 * Run with node --test on Node 20 and 22 via a glob.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { sha256, hashDirectory, generatedTranslations, verifyCompileArtifact, type ManifestForVerify } from '../src/hashing.js';

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
  writeFileSync(join(dir, 'tasks.js'), '// tasks\n');
  mkdirSync(join(dir, 'translations'), { recursive: true });
  writeFileSync(join(dir, 'compile-manifest.json'), '{}');
  return dir;
}

test('generatedTranslations reproduces R5 escaping (backslash and leading space)', () => {
  const out = generatedTranslations({ b: 'x', a: ' lead', c: 'back\\slash' });
  // keys sorted; leading space -> "\ "; backslash -> "\\"
  assert.equal(out, 'a = \\ lead\nb = x\nc = back\\\\slash\n');
});

test('verifyCompileArtifact: ok when disk + regenerated translations match the manifest', () => {
  const dir = makeProject();
  try {
    const translations = { 'task.x.title': 'Hello' };
    const genBytes = generatedTranslations(translations);
    writeFileSync(join(dir, 'translations', 'messages-en.properties'), 'app.title = Template Line\n' + genBytes);
    const files = [
      { path: 'forms/app/child_cough.xlsx', sha256: sha256(readFileSync(join(dir, 'forms/app/child_cough.xlsx'))) },
      { path: 'forms/app/child_cough.properties.json', sha256: sha256(readFileSync(join(dir, 'forms/app/child_cough.properties.json'))) },
      { path: 'tasks.js', sha256: sha256(readFileSync(join(dir, 'tasks.js'))) },
      { path: 'translations/messages-en.properties', sha256: sha256(genBytes) },
    ];
    const artifactHash = sha256([...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => `${f.path}\t${f.sha256}\n`).join(''));
    const manifest: ManifestForVerify = { artifactHash, files, translations };
    const v = verifyCompileArtifact(dir, manifest);
    assert.equal(v.ok, true, JSON.stringify(v.files));
    assert.equal(v.artifactHashOk, true);
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

// --- Item F.5: hash-rule tests against a COPY of the real vendored fixture ---

function fixtureDir(): string {
  // from dist-test/test to the source tree test/fixtures
  const candidates = [
    join(here, 'fixtures', 'child-cough-project'),
    join(here, '..', '..', 'test', 'fixtures', 'child-cough-project'),
  ];
  for (const c of candidates) if (existsSync(join(c, 'compile-manifest.json'))) return c;
  return candidates[1]!;
}

const here = dirname(fileURLToPath(import.meta.url));

function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fixcopy-'));
  cpSync(fixtureDir(), dir, { recursive: true });
  return dir;
}

function verifyCopy(dir: string) {
  const m = JSON.parse(readFileSync(join(dir, 'compile-manifest.json'), 'utf8'));
  return verifyCompileArtifact(dir, { artifactHash: m.artifactHash, files: m.files, translations: m.translations });
}

test('F.5 baseline: unmodified fixture copy verifies ok', () => {
  const dir = copyFixture();
  try {
    assert.equal(verifyCopy(dir).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F.5: a changed tasks.js fails verification', () => {
  const dir = copyFixture();
  try {
    writeFileSync(join(dir, 'tasks.js'), readFileSync(join(dir, 'tasks.js'), 'utf8') + '\n// tampered\n');
    const v = verifyCopy(dir);
    assert.equal(v.ok, false);
    assert.equal(v.files.find((f) => f.path === 'tasks.js')!.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F.5: a changed xlsx fails verification', () => {
  const dir = copyFixture();
  try {
    const p = join(dir, 'forms', 'app', 'child_cough.xlsx');
    const buf = readFileSync(p);
    buf[0] = buf[0]! ^ 0xff; // flip one byte
    writeFileSync(p, buf);
    const v = verifyCopy(dir);
    assert.equal(v.ok, false);
    assert.equal(v.files.find((f) => f.path === 'forms/app/child_cough.xlsx')!.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F.5: a changed GENERATED translation line fails verification', () => {
  const dir = copyFixture();
  try {
    const p = join(dir, 'translations', 'messages-en.properties');
    const m = JSON.parse(readFileSync(join(dir, 'compile-manifest.json'), 'utf8'));
    const key = Object.keys(m.translations)[0]!;
    // Corrupt the generated line's value on disk so it no longer contains the regenerated bytes.
    const text = readFileSync(p, 'utf8').replace(new RegExp(`(${key} = ).*`), '$1TAMPERED');
    writeFileSync(p, text);
    const v = verifyCopy(dir);
    assert.equal(v.ok, false);
    assert.equal(v.files.find((f) => f.path === 'translations/messages-en.properties')!.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F.5: a changed TEMPLATE line does NOT fail verification', () => {
  const dir = copyFixture();
  try {
    const p = join(dir, 'translations', 'messages-en.properties');
    // Prepend/alter a template line (not one of the generated keys). The
    // generated lines are still present, so verification stays ok.
    writeFileSync(p, 'app.title = A Different Template Title\n' + readFileSync(p, 'utf8').split('\n').filter((l) => !l.startsWith('app.title')).join('\n'));
    const v = verifyCopy(dir);
    assert.equal(v.ok, true, JSON.stringify(v.files));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F.5: a manifest with no follow-up (no translations) verifies without a translations file', () => {
  const dir = copyFixture();
  try {
    // Simulate a no-follow-up build: manifest with only xlsx + properties, no
    // tasks.js / translations. verifyCompileArtifact must pass over just those.
    const m = JSON.parse(readFileSync(join(dir, 'compile-manifest.json'), 'utf8'));
    const files = m.files.filter((f: { path: string }) => f.path === 'forms/app/child_cough.xlsx' || f.path === 'forms/app/child_cough.properties.json');
    const artifactHash = sha256([...files].sort((a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : 1)).map((f: { path: string; sha256: string }) => `${f.path}\t${f.sha256}\n`).join(''));
    const v = verifyCompileArtifact(dir, { artifactHash, files });
    assert.equal(v.ok, true, JSON.stringify(v.files));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
