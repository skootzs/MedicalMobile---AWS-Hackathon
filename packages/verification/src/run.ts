/**
 * Verification runner entry point.
 *
 * Compiled to plain ES2022 JS for Node 20 and mounted at /verifier, invoked as
 *   node /verifier/dist/run.js
 * Configured entirely through environment variables. No cht-core .mocharc.js;
 * the harness API is called directly. No model calls anywhere.
 *
 * Exit codes (see report.ts):
 *   0 passed | 1 verification failed with a valid report | 2 runner error.
 *
 * With no ExpectedOutcomeSource wired in (R4's evaluator and golden cases are
 * not available yet), every case is status 'error' with actuals recorded. The
 * runner NEVER writes an expected value or copies actuals into expected.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntegrityCheck, References, RunInfo, VerificationReport } from './report.js';
import { collectToolVersions, PythonTooOldError } from './versions.js';
import { compileArtifactHash, hashDirectory, sha256 } from './hashing.js';
import {
  PatientExecutor,
  derivePages,
  outputFieldsFromManifest,
  readManifest,
  type CaseExecutor,
  type ExecutionResult,
  type HarnessLike,
} from './case-executor.js';
import { buildReport, type ExecutedCase } from './report-builder.js';

const require = createRequire(import.meta.url);

const DEFAULT_TZ = 'Africa/Nairobi';
const DEFAULT_OUT = '/out';
const FIXED_CLOCK = '2026-02-15'; // deterministic clock for age and date calcs

interface Env {
  configDir: string;
  outDir: string;
  tz: string;
  references: References;
  expectedSnapshotHash: string | null;
}

class RunnerError extends Error {} // maps to exit 2 (no valid report)

function readEnv(): Env {
  const configDir = process.env.CHT_CONFIG_DIR;
  if (!configDir) throw new RunnerError('CHT_CONFIG_DIR is required');
  const orNull = (v: string | undefined): string | null => (v && v.length > 0 ? v : null);
  return {
    configDir,
    outDir: process.env.OUT_DIR || DEFAULT_OUT,
    tz: process.env.TZ || DEFAULT_TZ,
    references: {
      snapshotId: orNull(process.env.SNAPSHOT_ID),
      logicModelHash: orNull(process.env.LOGIC_MODEL_HASH),
      revision: orNull(process.env.REVISION),
      clinicalApprovalId: orNull(process.env.CLINICAL_APPROVAL_ID),
      compilationJobId: orNull(process.env.COMPILATION_JOB_ID),
      packageHash: orNull(process.env.PACKAGE_HASH),
    },
    expectedSnapshotHash: orNull(process.env.EXPECTED_SNAPSHOT_HASH),
  };
}

/** Load the real harness. Isolated so tests can inject a fake. */
function loadHarness(configDir: string, tz: string): HarnessLike {
  process.env.TZ = tz;
  const H = require('cht-conf-test-harness') as { default?: unknown } | unknown;
  const Ctor = ((H as { default?: unknown }).default ?? H) as new (o: unknown) => HarnessLike;
  return new Ctor({
    directory: configDir,
    appSettingsPath: join(configDir, 'app_settings.json'),
    headless: true,
  });
}

/**
 * The patient set is a list of { id, input } cases. At present there is no
 * wired source of inputs in-container, so this is empty unless a caller injects
 * one; an empty set makes the report fail (passed:false), which is correct.
 * This is where synth-generated patients will be fed in once reconciled.
 */
export interface PatientCase {
  id: string;
  branchId: string | null;
  kind: ExecutedCase['kind'];
  input: Record<string, unknown>;
}

export interface RunDeps {
  env: Env;
  harness: HarnessLike;
  executorFactory: (h: HarnessLike, formId: string, rowsPath: string, outputFields: string[]) => CaseExecutor;
  patients: PatientCase[];
  log: (line: string) => void;
}

export async function runVerification(deps: RunDeps): Promise<VerificationReport> {
  const { env, harness, log } = deps;
  const integrityChecks: IntegrityCheck[] = [];

  const toolVersions = await collectToolVersions(); // throws PythonTooOldError -> exit 2

  const manifest = readManifest(env.configDir);
  const formId = manifest.formId;

  // compileArtifactHash: recompute with R5's algorithm and compare to manifest.
  const recomputed = compileArtifactHash(env.configDir, formId);
  const hashOk = recomputed === manifest.artifactHash;
  integrityChecks.push({
    name: 'compileArtifactHash',
    ok: hashOk,
    detail: hashOk
      ? `recomputed hash matches manifest (${recomputed})`
      : `recomputed ${recomputed} != manifest ${manifest.artifactHash}`,
  });

  // Optional: EXPECTED_SNAPSHOT_HASH must equal manifest.snapshotHash.
  if (env.expectedSnapshotHash !== null) {
    const ok = env.expectedSnapshotHash === manifest.snapshotHash;
    integrityChecks.push({
      name: 'expectedSnapshotHash',
      ok,
      detail: ok
        ? 'EXPECTED_SNAPSHOT_HASH matches manifest.snapshotHash'
        : `EXPECTED_SNAPSHOT_HASH ${env.expectedSnapshotHash} != manifest.snapshotHash ${String(manifest.snapshotHash)}`,
    });
  }

  const testedDirHash = hashDirectory(env.configDir);

  // packageHash is echoed via references, never verified. (Deliberate no-op.)

  // Run cases.
  const rowsPath = join(env.configDir, 'compile-rows.json');
  const outputFields = outputFieldsFromManifest(manifest);
  const executor = deps.executorFactory(harness, formId, rowsPath, outputFields);

  const executed: ExecutedCase[] = [];
  const fallbackIds: string[] = [];
  if (deps.patients.length > 0) {
    await harness.start();
    try {
      for (const p of deps.patients) {
        let res: ExecutionResult;
        try {
          res = await executor.run({ id: p.id, input: p.input as never });
        } catch (e) {
          res = { actual: null, harnessOutput: `executor threw: ${String((e as Error).message ?? e)}`, usedPageFallback: false, status: 'error' };
        }
        if (res.usedPageFallback) fallbackIds.push(p.id);
        log(`case ${p.id}: status=${res.status} fallback=${res.usedPageFallback}`);
        // No ExpectedOutcomeSource is wired in: golden and evaluator stay null,
        // so every case derives to status 'error'. We NEVER synthesise expected.
        executed.push({
          id: p.id,
          input: p.input as never,
          branchId: p.branchId,
          kind: p.kind,
          actual: res.actual,
          harnessOutput: res.harnessOutput,
          golden: null,
          evaluator: null,
        });
      }
    } finally {
      await harness.stop();
    }
  }

  const run: RunInfo = { command: process.argv.slice(), tz: env.tz, seed: null };

  const report = buildReport({
    generatedAt: new Date().toISOString(),
    toolVersions,
    run,
    references: env.references,
    compileArtifactHash: recomputed,
    testedDirHash,
    patientSetHash: sha256(JSON.stringify(deps.patients)),
    goldenCasesHash: null, // no golden file supplied; never hash empty input
    coverage: { totalBranches: 0, coveredBranches: 0, uncoveredBranchIds: [] },
    pageFallbackCaseIds: fallbackIds,
    integrityChecks,
    cases: executed,
  });
  return report;
}

function writeOutputs(outDir: string, report: VerificationReport | null, logLines: string[]): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'verification.log'), logLines.join('\n') + '\n');
  if (report) writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}

async function main(): Promise<number> {
  const logLines: string[] = [];
  const log = (line: string): void => {
    logLines.push(`${new Date().toISOString()} ${line}`);
  };
  let env: Env;
  try {
    env = readEnv();
  } catch (e) {
    // No OUT_DIR known reliably if env is broken; fall back to default.
    const outDir = process.env.OUT_DIR || DEFAULT_OUT;
    log(`runner error: ${String((e as Error).message ?? e)}`);
    writeOutputs(outDir, null, logLines);
    return 2;
  }

  try {
    const harness = loadHarness(env.configDir, env.tz);
    const report = await runVerification({
      env,
      harness,
      executorFactory: (h, formId, rowsPath, outputFields) =>
        new PatientExecutor({ harness: h, formId, rowsFilePath: rowsPath, fixedClock: FIXED_CLOCK, outputFields }),
      patients: [], // no in-container patient source yet; empty => passed:false
      log,
    });
    writeOutputs(env.outDir, report, logLines);
    return report.passed ? 0 : 1;
  } catch (e) {
    if (e instanceof PythonTooOldError) {
      log(`runner error: ${e.message}`);
      writeOutputs(env.outDir, null, logLines);
      return 2;
    }
    // Any other failure that prevented a valid report: exit 2, no report.json.
    log(`runner error: ${String((e as Error).message ?? e)}`);
    writeOutputs(env.outDir, null, logLines);
    return 2;
  }
}

// Only run when invoked directly, so tests can import the module.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error('FATAL', e);
    process.exitCode = 2;
  });
}

export { derivePages };
