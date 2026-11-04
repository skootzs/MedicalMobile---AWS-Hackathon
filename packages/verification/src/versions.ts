/**
 * Tool-version detection and the Python version gate.
 *
 * The runner must record node, python, cht-conf, harness and chromium
 * versions, and fail (exit 2) if python3 is older than 3.10.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { ToolVersions } from './report.js';

const require = createRequire(import.meta.url);

export class PythonTooOldError extends Error {
  constructor(public readonly found: string) {
    super(`python3 is ${found}; 3.10 or later is required for form conversion`);
    this.name = 'PythonTooOldError';
  }
}

/** Raw `python3 --version` output, e.g. "Python 3.12.16". Throws if not found. */
export function readPythonVersion(): string {
  const out = execFileSync('python3', ['--version'], { encoding: 'utf8' }).trim();
  return out;
}

/** Parse "Python 3.12.16" -> [3, 12]. Returns null if unparseable. */
export function parsePythonMajorMinor(versionLine: string): [number, number] | null {
  const m = /(\d+)\.(\d+)/.exec(versionLine);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** True if version is 3.10 or later. */
export function isPythonSupported(versionLine: string): boolean {
  const mm = parsePythonMajorMinor(versionLine);
  if (!mm) return false;
  const [major, minor] = mm;
  return major > 3 || (major === 3 && minor >= 10);
}

function harnessVersion(): string {
  try {
    return (require('cht-conf-test-harness/package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

function chtConfVersion(): string {
  // cht-conf runs in the build stage, not necessarily installed beside the
  // runner. Prefer CHT_CONF_VERSION, then `cht --version`, then a resolvable
  // package.json, else 'unknown'. Never throw: version detection must not
  // prevent a valid report.
  const fromEnv = process.env.CHT_CONF_VERSION;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  try {
    const out = execFileSync('cht', ['--version'], { encoding: 'utf8' }).trim();
    // cht-conf prints e.g. "INFO 6.6.1" or "6.6.1"; take the first version token.
    const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(out);
    if (m) return m[1]!;
  } catch {
    // fall through to resolution
  }

  const tryResolve = (paths?: string[]): string | null => {
    try {
      const p = paths
        ? require.resolve('cht-conf/package.json', { paths })
        : require.resolve('cht-conf/package.json');
      return (require(p) as { version: string }).version;
    } catch {
      return null;
    }
  };
  let viaHarness: string | null = null;
  try {
    viaHarness = tryResolve([require.resolve('cht-conf-test-harness/package.json')]);
  } catch {
    viaHarness = null;
  }
  return viaHarness ?? tryResolve() ?? 'unknown';
}

/** True if no tool version is "unknown". Backs the toolVersionsKnown check. */
export function allToolVersionsKnown(tv: ToolVersions): boolean {
  return Object.values(tv).every((v) => v !== 'unknown');
}

/**
 * Resolve the Chromium revision the same way the harness does, via
 * puppeteer-chromium-resolver. Returns the revision string, or 'unknown' if it
 * cannot be resolved without launching a browser.
 */
export async function readChromiumRevision(): Promise<string> {
  try {
    const pcrPath = require.resolve('puppeteer-chromium-resolver', {
      paths: [require.resolve('cht-conf-test-harness/package.json')],
    });
    const PCR = require(pcrPath) as (opts: { silent: boolean }) => Promise<{ revision: string }>;
    const stats = await PCR({ silent: true });
    return String(stats.revision);
  } catch {
    return 'unknown';
  }
}

/**
 * Collect tool versions. Enforces the python gate: throws PythonTooOldError
 * (the caller maps this to exit 2) before returning.
 */
export async function collectToolVersions(): Promise<ToolVersions> {
  const python = readPythonVersion();
  if (!isPythonSupported(python)) throw new PythonTooOldError(python);
  return {
    node: process.version,
    python,
    chtConf: chtConfVersion(),
    chtConfTestHarness: harnessVersion(),
    chromiumRevision: await readChromiumRevision(),
  };
}
