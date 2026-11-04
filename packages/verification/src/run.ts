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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntegrityCheck, JsonValue, References, RunInfo, VerificationReport } from './report.js';
import { allToolVersionsKnown, collectToolVersions, PythonTooOldError } from './versions.js';
import { compileArtifactHash, hashDirectory, sha256 } from './hashing.js';
import {
  PatientExecutor,
  derivePages,
  computeObservedCoverage,
  outputFieldsFromManifest,
  readManifest,
  resolveBranchIds,
  type CaseExecutor,
  type ExecutionResult,
  type HarnessLike,
} from './case-executor.js';
import { mapPatientToPages, type MappablePatient } from './patient-mapper.js';
import { buildReport, type ExecutedCase } from './report-builder.js';

const require = createRequire(import.meta.url);

const DEFAULT_TZ = 'Africa/Nairobi';
const DEFAULT_OUT = '/out';
const FIXED_CLOCK = '2026-02-15'; // deterministic clock for age and date calcs

interface Env {
  configDir: string;
  outDir: string;
  tz: string;
  patientsFile: string | null;
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
    patientsFile: orNull(process.env.PATIENTS_FILE),
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

/** One patient as stored in patients.json (synth output). */
interface StoredPatient {
  id: string;
  kind: ExecutedCase['kind'];
  targetBranch: string | null;
  ageMonths: number | null;
  [field: string]: JsonValue;
}

/** Load patients.json (array of synth patients). Throws on malformed input. */
function loadPatients(path: string): StoredPatient[] {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw)) throw new RunnerError(`PATIENTS_FILE ${path} must contain a JSON array`);
  return raw as StoredPatient[];
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

/** A patient ready to execute: id/branch/kind plus the mapped input. */
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
  /** sha256 of the patients file bytes, or null when no file was supplied. */
  patientSetHash: string | null;
  /** Sample branch ids, used only if the manifest yields no outcomes. */
  sampleBranchIds?: string[] | null;
  log: (line: string) => void;
}

export async function runVerification(deps: RunDeps): Promise<VerificationReport> {
  const { env, harness, log } = deps;
  const integrityChecks: IntegrityCheck[] = [];

  const toolVersions = await collectToolVersions(); // throws PythonTooOldError -> exit 2
  integrityChecks.push({
    name: 'toolVersionsKnown',
    ok: allToolVersionsKnown(toolVersions),
    detail: allToolVersionsKnown(toolVersions)
      ? 'all tool versions resolved'
      : `one or more tool versions are "unknown": ${JSON.stringify(toolVersions)}`,
  });

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

  const run: RunInfo = {
    command: process.argv.slice(),
    tz: env.tz,
    seed: null,
    fixedClock: FIXED_CLOCK,
  };

  // Observed-outcome coverage. The required branch set is the manifest's
  // outcome ids (plus decisionTable.otherwise); if the manifest yields none we
  // fall back to the sample branch ids and keep the unconfirmed warning. A
  // branch counts as HIT only when an executed case with status ok produced
  // that branch id as its ACTUAL classification. This is observed-outcome
  // coverage; evaluator-trace coverage is a separate method added later and
  // must not silently replace it. No branch is excluded from the required set,
  // and there is no "known unreachable" allowlist.
  const resolved = resolveBranchIds(manifest, deps.sampleBranchIds ?? null);
  const classificationField = manifest.outputFields?.classification ?? 'classification';
  const { coveredBranchIds, uncoveredBranches } = computeObservedCoverage(
    resolved.branchIds,
    executed,
    classificationField,
  );
  const coverage = {
    method: 'observed-outcome' as const,
    branchSource: resolved.source,
    sampleWarning: resolved.source === 'sample' ? resolved.warning : null,
    totalBranches: resolved.branchIds.length,
    coveredBranches: coveredBranchIds.length,
    coveredBranchIds,
    uncoveredBranchIds: uncoveredBranches.map((u) => u.id),
    uncoveredBranches,
  };
  if (resolved.source === 'sample') log(resolved.warning);

  const report = buildReport({
    generatedAt: new Date().toISOString(),
    toolVersions,
    run,
    references: env.references,
    compileArtifactHash: recomputed,
    testedDirHash,
    patientSetHash: deps.patientSetHash ?? sha256(JSON.stringify([])),
    goldenCasesHash: null, // no golden file supplied; never hash empty input
    coverage,
    outputFields,
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
    // Load and map patients from PATIENTS_FILE, if supplied. patientSetHash is
    // the sha256 of the file's raw bytes (not a re-serialisation).
    let patients: PatientCase[] = [];
    let patientSetHash: string | null = null;
    if (env.patientsFile) {
      const bytes = readFileSync(env.patientsFile);
      patientSetHash = sha256(bytes);
      const stored = loadPatients(env.patientsFile);
      // Page derivation is needed to map inputs; done once here.
      const rowsPath = join(env.configDir, 'compile-rows.json');
      const pages = derivePages(rowsPath);
      patients = stored.map((p) => ({
        id: p.id,
        branchId: p.targetBranch,
        kind: p.kind,
        input: {
          ageMonths: p.ageMonths,
          pageAnswers: mapPatientToPages(p as MappablePatient, pages),
        },
      }));
      log(`loaded ${patients.length} patients from ${env.patientsFile}`);
    } else {
      log('no PATIENTS_FILE supplied; running with an empty patient set (passed will be false)');
    }

    const harness = loadHarness(env.configDir, env.tz);
    const report = await runVerification({
      env,
      harness,
      executorFactory: (h, formId, rowsPath, outputFields) =>
        new PatientExecutor({ harness: h, formId, rowsFilePath: rowsPath, fixedClock: FIXED_CLOCK, outputFields }),
      patients,
      patientSetHash,
      // Sample branch ids (used only if the manifest has no outcomes): the
      // distinct targetBranch values from the loaded patient set.
      sampleBranchIds: [
        ...new Set(patients.map((p) => p.branchId).filter((b): b is string => b !== null)),
      ].sort(),
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
