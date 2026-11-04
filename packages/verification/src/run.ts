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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IntegrityCheck, JsonValue, References, RunInfo, VerificationReport } from './report.js';
import { allToolVersionsKnown, collectToolVersions, PythonTooOldError } from './versions.js';
import { hashDirectory, sha256, verifyCompileArtifact } from './hashing.js';
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
import { buildReport, type ExecutedCase, type SourceExpectation } from './report-builder.js';

const require = createRequire(import.meta.url);

const DEFAULT_OUT = '/out';
const FIXED_CLOCK = '2026-02-15'; // deterministic clock for age and date calcs

/** Directory of the compiled runner (dist/), for resolving bundled data. */
function runnerDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Sanitize argv for the report: keep only the basenames of the node binary and
 * the script, so no absolute local paths (e.g. the npx cache) or environment
 * values are recorded. argv[0] -> its basename (usually "node"), argv[1] ->
 * script basename, and any further args are kept verbatim only if they contain
 * no path separator (defensive; the runner takes no positional args today).
 */
export function sanitizeCommand(argv: readonly string[]): string[] {
  const out: string[] = [];
  if (argv[0] !== undefined) out.push(basename(argv[0]));
  if (argv[1] !== undefined) out.push(basename(argv[1]));
  for (const extra of argv.slice(2)) {
    out.push(extra.includes('/') || extra.includes('\\') ? basename(extra) : extra);
  }
  return out;
}

interface Env {
  configDir: string;
  outDir: string;
  tz: string;
  patientsFile: string | null;
  goldenCasesFile: string | null;
  references: References;
  expectedSnapshotHash: string | null;
}

class RunnerError extends Error {} // maps to exit 2 (no valid report)

function readEnv(): Env {
  const configDir = process.env.CHT_CONFIG_DIR;
  if (!configDir) throw new RunnerError('CHT_CONFIG_DIR is required');
  const orNull = (v: string | undefined): string | null => (v && v.length > 0 ? v : null);
  // TZ must be pinned explicitly (item 5): t_follow_up_date and age depend on
  // it, so an unset TZ would make the run non-reproducible. Fail fast (exit 2).
  const tz = process.env.TZ;
  if (!tz || tz.length === 0) {
    throw new RunnerError('TZ is required and must be set explicitly (e.g. Africa/Nairobi)');
  }
  // Validate the IANA zone name; an invalid TZ would silently fall back to a
  // different zone and make t_follow_up_date wrong. Fail fast (exit 2).
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    throw new RunnerError(`TZ is not a valid time zone name: ${JSON.stringify(tz)}`);
  }
  return {
    configDir,
    outDir: process.env.OUT_DIR || DEFAULT_OUT,
    tz,
    patientsFile: orNull(process.env.PATIENTS_FILE),
    goldenCasesFile: orNull(process.env.GOLDEN_CASES_FILE),
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
  /** Optional golden expected-outcome source for this case (H). */
  golden?: SourceExpectation | null;
}

export interface RunDeps {
  env: Env;
  harness: HarnessLike;
  executorFactory: (h: HarnessLike, formId: string, rowsPath: string, outputFields: string[]) => CaseExecutor;
  patients: PatientCase[];
  /** sha256 of the patients file bytes, or null when no file was supplied. */
  patientSetHash: string | null;
  /** sha256 of the golden file bytes, or null when no golden file was supplied. */
  goldenCasesHash?: string | null;
  /** Extra output fields the golden sources declare, for the executor to read. */
  extraOutputFields?: string[];
  /** Info-level integrity note about the golden file (never a failing check). */
  goldenInfo?: IntegrityCheck | null;
  /** Sample branch ids, used only if the manifest yields no outcomes. */
  sampleBranchIds?: string[] | null;
  log: (line: string) => void;
}

export async function runVerification(deps: RunDeps): Promise<VerificationReport> {
  const { env, harness, log } = deps;
  const integrityChecks: IntegrityCheck[] = [];

  // `cht --version` is run against the tested project directory (item 4).
  const collected = await collectToolVersions(env.configDir); // throws PythonTooOldError -> exit 2
  const toolVersions = collected.versions;
  integrityChecks.push({
    name: 'toolVersionsKnown',
    ok: allToolVersionsKnown(toolVersions),
    detail: allToolVersionsKnown(toolVersions)
      ? `all tool versions resolved (cht-conf via ${collected.chtConfSource})`
      : `one or more tool versions are "unknown" (cht-conf via ${collected.chtConfSource}): ${JSON.stringify(toolVersions)}`,
  });

  const manifest = readManifest(env.configDir);

  // compileArtifactHash: verify each manifest file against disk (translations
  // regenerated from manifest.translations and checked to be present on disk),
  // plus manifest.artifactHash internal consistency. One line per file.
  const artifact = verifyCompileArtifact(env.configDir, {
    artifactHash: manifest.artifactHash,
    files: manifest.files ?? [],
    ...(manifest.translations ? { translations: manifest.translations } : {}),
  });
  integrityChecks.push({
    name: 'compileArtifactHash',
    ok: artifact.ok,
    detail: artifact.files.map((f) => `${f.path}: ${f.ok ? 'ok' : 'FAIL'} (${f.detail})`).join('; '),
  });

  // LOGIC_MODEL_HASH: if set, must equal manifest.inputHash; if not set,
  // recorded as "not provided" and NOT ok.
  {
    const provided = env.references.logicModelHash;
    if (provided === null) {
      integrityChecks.push({ name: 'logicModelHash', ok: false, detail: 'not provided' });
    } else {
      const ok = provided === manifest.inputHash;
      integrityChecks.push({
        name: 'logicModelHash',
        ok,
        detail: ok
          ? 'LOGIC_MODEL_HASH matches manifest.inputHash'
          : `LOGIC_MODEL_HASH ${provided} != manifest.inputHash ${String(manifest.inputHash)}`,
      });
    }
  }

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
  // Add a golden info note (never a failing check) if provided.
  if (deps.goldenInfo) integrityChecks.push(deps.goldenInfo);

  const rowsPath = join(env.configDir, 'compile-rows.json');
  // The executor must record every field any source declares (H2), so union
  // the manifest output fields with the golden sources' declared fields.
  const outputFields = [...new Set([...outputFieldsFromManifest(manifest), ...(deps.extraOutputFields ?? [])])];
  const executor = deps.executorFactory(harness, manifest.formId, rowsPath, outputFields);

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
        // golden comes from GOLDEN_CASES_FILE when present; evaluator is not
        // wired yet. We NEVER synthesise an expected value.
        executed.push({
          id: p.id,
          input: p.input as never,
          branchId: p.branchId,
          kind: p.kind,
          actual: res.actual,
          harnessOutput: res.harnessOutput,
          golden: p.golden ?? null,
          evaluator: null,
        });
      }
    } finally {
      await harness.stop();
    }
  }

  const run: RunInfo = {
    command: sanitizeCommand(process.argv),
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
    compileArtifactHash: manifest.artifactHash,
    testedDirHash,
    patientSetHash: deps.patientSetHash ?? sha256(JSON.stringify([])),
    goldenCasesHash: deps.goldenCasesHash ?? null, // never hash empty input
    coverage,
    classificationField,
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
    // Resolve the patients file: PATIENTS_FILE if set, else the bundled
    // data/patients.json next to the compiled runner (copied at build time).
    // patientSetHash is the sha256 of the chosen file's raw bytes.
    let patients: PatientCase[] = [];
    let patientSetHash: string | null = null;
    let patientsFile: string | null = env.patientsFile;
    if (!patientsFile) {
      const bundled = join(runnerDir(), 'data', 'patients.json');
      if (existsSync(bundled)) {
        patientsFile = bundled;
        log(`PATIENTS_FILE unset; using bundled patient set at ${bundled}`);
      } else {
        log('no PATIENTS_FILE and no bundled data/patients.json; running with an empty patient set (passed will be false)');
      }
    }
    if (patientsFile) {
      const bytes = readFileSync(patientsFile);
      patientSetHash = sha256(bytes);
      const stored = loadPatients(patientsFile);
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
      log(`loaded ${patients.length} patients from ${patientsFile}`);
    }

    // Golden cases (optional). Each becomes an additional case "golden/<id>"
    // whose golden source declares exactly the keys of its `expected`. Inputs
    // are the raw form ids; absent/null => unanswered (we never invent answers).
    let goldenCasesHash: string | null = null;
    let goldenInfo: IntegrityCheck | null = null;
    const extraOutputFields = new Set<string>();
    if (env.goldenCasesFile) {
      const bytes = readFileSync(env.goldenCasesFile);
      goldenCasesHash = sha256(bytes);
      const golden = JSON.parse(bytes.toString('utf8')) as Array<{
        id: string;
        approval?: string;
        input?: Record<string, unknown>;
        expected: Record<string, JsonValue>;
      }>;
      const rowsPath = join(env.configDir, 'compile-rows.json');
      const pages = derivePages(rowsPath);
      const approvals = [...new Set(golden.map((c) => c.approval ?? '(none)'))];
      goldenInfo = {
        name: 'goldenCasesInfo',
        ok: true, // informational, never a failing check
        detail:
          `${golden.length} golden cases from ${env.goldenCasesFile}; approval values: ${JSON.stringify(approvals)}. ` +
          'Technical expectations, not clinician-approved; never treated as approval (clinicalApprovalId is the only approval reference).',
      };
      for (const gc of golden) {
        const input = gc.input ?? {};
        const ageMonths = typeof input['patient_age_in_months'] === 'number' ? (input['patient_age_in_months'] as number) : null;
        // Map form-id answers directly; absent/null keys stay unanswered.
        const mappable = input as MappablePatient;
        for (const k of Object.keys(gc.expected)) extraOutputFields.add(k);
        const source: SourceExpectation = { expected: gc.expected, fields: Object.keys(gc.expected) };
        patients.push({
          id: `golden/${gc.id}`,
          branchId: null,
          kind: 'branch',
          input: { ageMonths, pageAnswers: mapPatientToPages(mappable, pages) },
          golden: source,
        });
      }
      log(`loaded ${golden.length} golden cases from ${env.goldenCasesFile}`);
    }

    const harness = loadHarness(env.configDir, env.tz);
    const report = await runVerification({
      env,
      harness,
      goldenCasesHash,
      goldenInfo,
      extraOutputFields: [...extraOutputFields],
      executorFactory: (h, formId, rowsPath, outputFields) =>
        new PatientExecutor({
          harness: h,
          formId,
          rowsFilePath: rowsPath,
          fixedClock: FIXED_CLOCK,
          outputFields,
          observeTasks: true,
          followUpTitleMatch: 'follow_up',
        }),
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
