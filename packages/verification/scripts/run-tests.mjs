/**
 * Test selector: runs node:test over the compiled test files in
 * dist-test/test, choosing the quick suite (default) or the slow suite.
 *
 *   node scripts/run-tests.mjs           # quick: *.test.js excluding *.slow.test.js
 *   node scripts/run-tests.mjs --slow    # slow:  *.slow.test.js only
 *
 * The slow suite holds tests that start the real runner and Chromium
 * (exit-codes, verify-stage, golden); the quick suite is pure unit tests.
 */
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, '..', 'dist-test', 'test');
const slow = process.argv.includes('--slow');

if (!existsSync(testDir)) {
  console.error(`compiled tests not found at ${testDir}; run "npm run build:test" first`);
  process.exit(1);
}

const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => (slow ? f.endsWith('.slow.test.js') : !f.endsWith('.slow.test.js')))
  .sort()
  .map((f) => join(testDir, f));

if (files.length === 0) {
  console.error(`no ${slow ? 'slow' : 'quick'} test files found in ${testDir}`);
  process.exit(1);
}

const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
