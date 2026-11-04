import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { compileArgs, convertArgs, verifyArgs } from '../launch-build.ts';
import { canonicalJson, sha256 } from '../src/hashing.ts';
import { buildManifest, deterministicTgz, listProjectFiles } from '../src/package.ts';

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'pkg-'));
  mkdirSync(join(root, 'forms/app'), { recursive: true });
  writeFileSync(join(root, 'forms/app/f.xml'), '<xml/>');
  writeFileSync(join(root, 'tasks.js'), 'module.exports=[]');
  chmodSync(join(root, 'tasks.js'), 0o755);
  writeFileSync(join(root, 'convert.log'), `log ${Math.random()}`);
  mkdirSync(join(root, 'shiv'));
  writeFileSync(join(root, 'shiv/cache'), String(Math.random()));
  return root;
}

describe('deterministic package', () => {
  it('packaging the same folder twice gives the same hash', () => {
    const root = project();
    assert.equal(sha256(deterministicTgz(root)), sha256(deterministicTgz(root)));
  });

  it('mtimes, logs and the shiv cache do not change the hash', () => {
    const a = project();
    const b = project();
    utimesSync(join(b, 'tasks.js'), new Date(1000), new Date(1000));
    assert.equal(sha256(deterministicTgz(a)), sha256(deterministicTgz(b)));
  });

  it('content changes the hash', () => {
    const a = project();
    const before = sha256(deterministicTgz(a));
    writeFileSync(join(a, 'tasks.js'), 'changed');
    assert.notEqual(before, sha256(deterministicTgz(a)));
  });

  it('system tar unpacks it to the same content, modes and long paths', () => {
    const root = project();
    const deep = `forms/app/${'d'.repeat(60)}/${'e'.repeat(60)}`;
    mkdirSync(join(root, deep), { recursive: true });
    writeFileSync(join(root, deep, 'f.txt'), 'deep');
    const out = mkdtempSync(join(tmpdir(), 'unpack-'));
    const tgz = join(out, 'p.tgz');
    writeFileSync(tgz, deterministicTgz(root));
    const dest = join(out, 'x');
    mkdirSync(dest);
    execFileSync('tar', ['-xzf', tgz, '-C', dest]);
    assert.equal(readFileSync(join(dest, deep, 'f.txt'), 'utf8'), 'deep');
    assert.equal(readFileSync(join(dest, 'forms/app/f.xml'), 'utf8'), '<xml/>');
    assert.deepEqual(listProjectFiles(dest).map((f) => f.path), listProjectFiles(root).map((f) => f.path));
    assert.equal(listProjectFiles(dest).find((f) => f.path === 'tasks.js')!.executable, true);
  });

  it('refuses symlinks', () => {
    const root = project();
    symlinkSync('/etc/passwd', join(root, 'link'));
    assert.throws(() => deterministicTgz(root), /symlink/);
  });

  it('manifest hash is over its canonical bytes and lists logs separately', () => {
    const root = project();
    const { manifest, bytes, manifestHash } = buildManifest(root, { 'convert.log': 'x' });
    assert.equal(manifestHash, sha256(bytes));
    assert.equal(bytes, canonicalJson(JSON.parse(bytes)));
    assert.ok(manifest.files.some((f) => f.path === 'forms/app/f.xml'));
    assert.ok(!manifest.files.some((f) => f.path.startsWith('shiv')));
    assert.deepEqual(manifest.logs, [{ path: 'convert.log', sha256: sha256('x') }]);
  });
});

describe('canonical input hash', () => {
  it("matches the inputHash R5's compiler produced for its child-cough fixture", () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/child-cough.logic.json', import.meta.url), 'utf8'));
    assert.equal(sha256(canonicalJson(fixture)), '186214726c73a4b8db5e641a5b28a7fc6c42689078d7fcacdf3839a8f1ee1a67');
  });
});

describe('container flags', () => {
  const shared = ['--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--tmpfs', '/tmp', '--user', '1000:1000'];
  const hasAll = (args: string[], want: string[]) => assert.ok(args.join(' ').includes(want.join(' ')), args.join(' '));
  const compile = { image: 'c', inDir: '/i', templateDir: '/t', compilerDir: '/k', outDir: '/o', snapshotHash: 'sha256:x' };

  it('compile is offline and read-only, with ro inputs and optional flags', () => {
    const plain = compileArgs(compile, 'n');
    hasAll(plain, shared);
    for (const mount of ['/i:/in:ro', '/t:/template:ro', '/k:/compiler:ro', '/o:/out']) assert.ok(plain.includes(mount), mount);
    assert.ok(!plain.includes('SYS_ADMIN'));
    assert.ok(!plain.includes('--baseline'));
    const full = compileArgs({ ...compile, baselineDir: '/b', taskWindow: '1,3', watermark: 'W' }, 'n');
    assert.ok(full.includes('/b:/baseline:ro'));
    hasAll(full, ['--baseline', '/baseline']);
    hasAll(full, ['--task-window', '1,3']);
    hasAll(full, ['--watermark', 'W']);
  });

  it('convert has no SYS_ADMIN and sets SHIV_ROOT', () => {
    const args = convertArgs({ image: 'b', workDir: '/w' }, 'n');
    hasAll(args, shared);
    assert.ok(!args.includes('SYS_ADMIN'));
    assert.ok(args.includes('SHIV_ROOT=/work/shiv'));
    hasAll(args, ['sh', '/run-convert.sh']);
  });

  it('only verify adds SYS_ADMIN, and /project is read-only', () => {
    const args = verifyArgs({ image: 'b', projectDir: '/p', inDir: '/in-dir', verifierDir: '/v', outDir: '/o', packageHash: 'p', compileArtifactHash: 'a', inputHash: 'i', hasGoldenCases: false }, 'n');
    hasAll(args, shared);
    hasAll(args, ['--cap-add', 'SYS_ADMIN']);
    assert.ok(args.includes('/p:/project:ro'));
    assert.ok(args.includes('/v:/verifier:ro'));
  });
});
