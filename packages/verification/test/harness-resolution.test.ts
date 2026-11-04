/**
 * Item I1: harness module resolution order. Pure test using an injected
 * resolver and env, so it is quick (no real harness load).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHarnessModulePath } from '../src/run.js';

const MOD = 'cht-conf-test-harness';

test('I1: uses normal resolution after the baked image path misses', () => {
  const resolver = (req: string, paths?: string[]) => {
    assert.equal(req, MOD);
    if (paths !== undefined) throw new Error('not the baked copy');
    return '/default/node_modules/cht-conf-test-harness';
  };
  const r = resolveHarnessModulePath(resolver, {});
  assert.deepEqual(r, { path: '/default/node_modules/cht-conf-test-harness', via: 'normal' });
});

test('I1: falls back to HARNESS_MODULE_PATH when default fails', () => {
  const resolver = (_req: string, paths?: string[]) => {
    if (paths === undefined) throw new Error('not found by default');
    if (paths[0] === '/custom/nm') return '/custom/nm/cht-conf-test-harness';
    throw new Error('nope');
  };
  const r = resolveHarnessModulePath(resolver, { HARNESS_MODULE_PATH: '/custom/nm' });
  assert.equal(r?.via, 'HARNESS_MODULE_PATH');
  assert.equal(r?.path, '/custom/nm/cht-conf-test-harness');
});

test('I1: falls back to /build-image/node_modules last', () => {
  const resolver = (_req: string, paths?: string[]) => {
    if (paths && paths[0] === '/build-image/node_modules') return '/build-image/node_modules/cht-conf-test-harness';
    throw new Error('not here');
  };
  const r = resolveHarnessModulePath(resolver, {});
  assert.equal(r?.via, '/build-image/node_modules');
});

test('I1: returns null when nothing resolves (runner then exits 2)', () => {
  const resolver = () => {
    throw new Error('never');
  };
  assert.equal(resolveHarnessModulePath(resolver, {}), null);
});
