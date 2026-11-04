/**
 * Items 3/4/5 tests: sanitized run.command, cht-conf version source order,
 * and the TZ fail-fast is covered in run-level tests (Part 6). Here we unit
 * test the pure pieces.
 *
 * Run with node --test on Node 20 and 22 via a glob.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCommand } from '../src/run.js';
import { chtConfVersion } from '../src/versions.js';

// --- Item 3: sanitizeCommand ---

test('sanitizeCommand strips absolute paths to basenames', () => {
  const out = sanitizeCommand([
    '/home/participant/.npm/_npx/abc123/node_modules/node/bin/node',
    '/verifier/dist/run.js',
  ]);
  assert.deepEqual(out, ['node', 'run.js']);
});

test('sanitizeCommand keeps plain flags but basenames path-like extras', () => {
  const out = sanitizeCommand(['/usr/bin/node', '/x/run.js', '--verbose', '/secret/path/file']);
  assert.deepEqual(out, ['node', 'run.js', '--verbose', 'file']);
});

test('sanitizeCommand carries no absolute path or cache segment', () => {
  const out = sanitizeCommand([
    '/home/u/.npm/_npx/deadbeef/node_modules/node/bin/node',
    '/verifier/dist/run.js',
  ]);
  for (const token of out) {
    assert.ok(!token.includes('/'), `token leaked a path: ${token}`);
    assert.ok(!token.includes('_npx'), `token leaked npx cache: ${token}`);
  }
});

// --- Item 4: chtConfVersion source order ---

test('chtConfVersion falls back to CHT_CONF_VERSION when cht is absent', () => {
  const prevPath = process.env.PATH;
  const prevEnv = process.env.CHT_CONF_VERSION;
  try {
    process.env.PATH = '/nonexistent-bin'; // ensure `cht` is not found
    process.env.CHT_CONF_VERSION = '7.7.7';
    const r = chtConfVersion('/tmp');
    assert.equal(r.source, 'CHT_CONF_VERSION');
    assert.equal(r.version, '7.7.7');
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevEnv === undefined) delete process.env.CHT_CONF_VERSION;
    else process.env.CHT_CONF_VERSION = prevEnv;
  }
});

test('chtConfVersion returns unknown/unknown when nothing resolves', () => {
  const prevPath = process.env.PATH;
  const prevEnv = process.env.CHT_CONF_VERSION;
  try {
    process.env.PATH = '/nonexistent-bin';
    delete process.env.CHT_CONF_VERSION;
    const r = chtConfVersion('/tmp');
    // In this test package cht-conf is not resolvable, so expect unknown.
    assert.equal(r.version, 'unknown');
    assert.equal(r.source, 'unknown');
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevEnv !== undefined) process.env.CHT_CONF_VERSION = prevEnv;
  }
});
