/**
 * Spawn the Python evaluator bridge (python/expected.py) once for a batch of
 * cases and parse its JSON. No clinical logic here; this only shells out.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { JsonValue } from './report.js';

export interface BridgeCase {
  id: string;
  answers: Record<string, JsonValue>;
}

export interface BridgeResultOk {
  id: string;
  ok: true;
  outcomeId: string;
  referral: string;
  followUpDays: number | null;
  followUpDate: string | null;
  matchedRows: number[];
  appliedOtherwise: boolean;
}
export interface BridgeResultErr {
  id: string;
  ok: false;
  error: string;
}
export type BridgeResult = BridgeResultOk | BridgeResultErr;

export interface BridgeOutcome {
  /** exit 2 from the bridge (python too old / jsonschema missing / no root). */
  fatal: boolean;
  fatalMessage?: string;
  results: BridgeResult[];
  evaluatorRoot?: string;
  evaluatorSource?: string;
  pythonVersion?: string;
  jsonschemaVersion?: string;
}

/** The five source files whose sha256 make up evaluatorHash. */
export const EVALUATOR_SOURCE_FILES = [
  'packages/schema/validate.py',
  'packages/schema/src/logic-model.schema.json',
  'packages/evaluator/evaluate.py',
  'packages/evaluator/condition_evaluator.py',
  'packages/checker/check_model.py',
];

/** evaluatorHash over the five source files actually used at `root`. */
export function evaluatorHash(root: string): string {
  const lines = [...EVALUATOR_SOURCE_FILES]
    .map((f) => `${f}\t${createHash('sha256').update(readFileSync(join(root, f))).digest('hex')}\n`)
    .sort()
    .join('');
  return createHash('sha256').update(lines).digest('hex');
}

/** Path to python/expected.py relative to the compiled runner (dist/). */
function bridgeScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/
  // python/ sits beside src/ in the repo; from dist/ go up to the package root.
  return join(here, '..', 'python', 'expected.py');
}

export function runEvaluatorBridge(modelPath: string, cases: BridgeCase[], asOf: string): BridgeOutcome {
  const dir = mkdtempSync(join(tmpdir(), 'eval-cases-'));
  try {
    const casesPath = join(dir, 'cases.json');
    writeFileSync(casesPath, JSON.stringify(cases));
    const pythonBin = process.env['PYTHON_BIN'] || 'python3';
    const res = spawnSync(
      pythonBin,
      [bridgeScriptPath(), '--model', modelPath, '--cases', casesPath, '--as-of', asOf],
      { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
    );
    if (res.status === 2) {
      return { fatal: true, fatalMessage: (res.stderr || '').trim(), results: [] };
    }
    if (res.status !== 0) {
      return { fatal: true, fatalMessage: `evaluator bridge exited ${res.status}: ${(res.stderr || '').trim()}`, results: [] };
    }
    let meta: { evaluatorRoot?: string; evaluatorSource?: string; pythonVersion?: string; jsonschemaVersion?: string } = {};
    const lastLine = (res.stderr || '').trim().split('\n').pop() ?? '';
    try {
      meta = JSON.parse(lastLine);
    } catch {
      // meta is best-effort
    }
    const results = JSON.parse(res.stdout) as BridgeResult[];
    return { fatal: false, results, ...meta };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
