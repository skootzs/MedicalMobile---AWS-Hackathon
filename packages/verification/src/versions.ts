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

/** Where the cht-conf version came from, recorded for the integrityCheck. */
export type ChtConfVersionSource = 'cht --version' | 'CHT_CONF_VERSION' | 'package.json' | 'unknown';

export interface ChtConfVersion {
  version: string;
  source: ChtConfVersionSource;
}

/**
 * cht-conf runs in the build stage, not necessarily installed beside the
 * runner. Resolution order (per item 4):
 *   1. `cht --version` run against the tested project (cwd), if available;
 *   2. the CHT_CONF_VERSION env var;
 *   3. a resolvable cht-conf/package.json;
 *   4. "unknown".
 * Never throws: version detection must not prevent a valid report. The chosen
 * source is returned so the toolVersionsKnown check can report it honestly.
 */
export function chtConfVersion(cwd?: string): ChtConfVersion {
  try {
    const out = execFileSync('cht', ['--version'], {
      encoding: 'utf8',
      ...(cwd ? { cwd } : {}),
    }).trim();
    // cht-conf prints e.g. "INFO 6.6.1" or "6.6.1"; take the first version token.
    const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(out);
    if (m) return { version: m[1]!, source: 'cht --version' };
  } catch {
    // fall through
  }

  const fromEnv = process.env.CHT_CONF_VERSION;
  if (fromEnv && fromEnv.length > 0) return { version: fromEnv, source: 'CHT_CONF_VERSION' };

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
  const resolved = viaHarness ?? tryResolve();
  if (resolved) return { version: resolved, source: 'package.json' };
  return { version: 'unknown', source: 'unknown' };
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

export interface CollectedToolVersions {
  versions: ToolVersions;
  /** How the cht-conf version was obtained, for the toolVersionsKnown detail. */
  chtConfSource: ChtConfVersionSource;
}

/**
 * Collect tool versions. Enforces the python gate: throws PythonTooOldError
 * (the caller maps this to exit 2) before returning. `cwd`, when given, is the
 * tested project directory used to run `cht --version`.
 */
export async function collectToolVersions(cwd?: string): Promise<CollectedToolVersions> {
  const python = readPythonVersion();
  if (!isPythonSupported(python)) throw new PythonTooOldError(python);
  const chtConf = chtConfVersion(cwd);
  return {
    versions: {
      node: process.version,
      python,
      chtConf: chtConf.version,
      chtConfTestHarness: harnessVersion(),
      chromiumRevision: await readChromiumRevision(),
    },
    chtConfSource: chtConf.source,
  };
}
