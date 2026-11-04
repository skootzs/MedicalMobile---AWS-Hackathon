import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { join, posix } from 'node:path';
import type { RunnerConfig } from './config.ts';
import { canonicalJson, hexOf, sha256 } from './hashing.ts';
import { buildManifest, deterministicTgz } from './package.ts';
import type { JobStore, LeaseRef } from './store.ts';
import {
  CONTRACT_VERSION,
  validateJobPayload,
  validateJobResult,
  validateVerifyBuildPayload,
  type JobErrorCode,
  type JobPayload,
  type JobResult,
  type VerifyBuildPayload,
} from './generated/handoffs.ts';
import type { StageResult, Stages } from '../launch-build.ts';

export interface QueueMessage {
  messageId: string;
  receiptHandle: string;
  receiveCount: number;
  body: string;
}

export interface Queue {
  delete(message: QueueMessage): Promise<void>;
  setVisibility(message: QueueMessage, seconds: number): Promise<void>;
}

export interface StoredArtifact {
  uri: string;
  versionId?: string;
}

export interface Artifacts {
  get(uri: string): Promise<Buffer>;
  put(key: string, body: string | Buffer): Promise<StoredArtifact>;
}

export interface WorkerDeps {
  config: RunnerConfig;
  store: JobStore;
  queue: Queue;
  artifacts: Artifacts;
  stages: Stages;
  log?: (level: 'info' | 'error', message: string, detail?: unknown) => void;
  now?: () => number;
}

export type Outcome = 'SUCCEEDED' | 'FAILED' | 'RETRYING' | 'SKIPPED' | 'LEASE_LOST' | 'LEFT_ON_QUEUE';

// retryable=false ends the job; retryable=true returns it to PENDING for redelivery.
class JobFailure extends Error {
  readonly code: JobErrorCode;
  readonly retryable: boolean;
  readonly fields: Partial<JobResult>;

  constructor(code: JobErrorCode, message: string, retryable: boolean, fields: Partial<JobResult> = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.fields = fields;
  }
}

// R2 requires the verifier to be a different actor from the compiler.
export function runnerActorId(workerId: string, jobType: unknown): string {
  return `${workerId}-${jobType === 'VERIFY_BUILD' ? 'verify' : 'compile'}`;
}

// R2's vocabulary for where a COMPILE_LOGIC job stopped.
const AFTER_CONVERT = { compilerExitCode: 0, chtConfStatus: 'PASSED' } as const;
const CONVERT_FAILED_FIELDS = { compilerExitCode: 0, chtConfStatus: 'FAILED' } as const;

function versionField<K extends string>(field: K, stored: StoredArtifact): Partial<Record<K, string>> {
  return stored.versionId ? { [field]: stored.versionId } as Record<K, string> : {};
}

function parseBucketKey(uri: string): { bucket: string; key: string } | undefined {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  return match ? { bucket: match[1]!, key: match[2]! } : undefined;
}

function checkOwnBucket(uri: string, bucket: string, field: string): void {
  const parsed = parseBucketKey(uri);
  if (!parsed || parsed.bucket !== bucket || parsed.key.split('/').includes('..')) {
    throw new JobFailure('INVALID_PAYLOAD', `${field} is not inside the artifact bucket`, false);
  }
}

function errorsText(errors: unknown): string {
  return JSON.stringify(errors).slice(0, 1000);
}

// The outbox Pipe sends the whole DynamoDB stream record, possibly as a batch of one. The
// payload attribute is a Map, or a JSON string if a writer stores it that way. A body that
// isn't a stream record is already the payload.
export function decodeBody(body: string): unknown {
  try {
    const parsed: unknown = JSON.parse(body);
    const record = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] as unknown : parsed;
    const attribute = (record as { dynamodb?: { NewImage?: { payload?: unknown } } } | null)?.dynamodb?.NewImage?.payload;
    if (attribute === undefined) return record;
    const { payload } = unmarshall({ payload: attribute } as unknown as Parameters<typeof unmarshall>[0]) as { payload: unknown };
    return typeof payload === 'string' ? JSON.parse(payload) as unknown : payload;
  } catch {
    return undefined;
  }
}

export function validatePayload(raw: unknown): { payload: JobPayload | VerifyBuildPayload } | { error: string } {
  const type = (raw as { jobType?: unknown } | null)?.jobType;
  if (type === 'VERIFY_BUILD') {
    return validateVerifyBuildPayload(raw)
      ? { payload: raw as VerifyBuildPayload }
      : { error: errorsText(validateVerifyBuildPayload.errors) };
  }
  if (!validateJobPayload(raw)) return { error: errorsText(validateJobPayload.errors) };
  const payload = raw as JobPayload;
  if (payload.jobType === 'COMPILE_LOGIC' && !payload.mode) return { error: 'COMPILE_LOGIC requires mode' };
  return { payload };
}

// Exit 1 with parseable compiler errors is a model rejection. Exit 1 with anything else
// is node itself failing (e.g. a bad /compiler mount), which a retry or fix can resolve.
export function classifyCompile(result: StageResult): JobFailure | undefined {
  if (result.timedOut) return new JobFailure('TIMEOUT', 'Compile stage timed out', true, { failureKind: 'TIMED_OUT' });
  if (result.exitCode === 0) return undefined;
  if (result.exitCode === 1) {
    try {
      const parsed = JSON.parse(result.stderr) as { ok?: boolean; errors?: { code: string; path: string; message: string }[] };
      if (parsed.ok === false && Array.isArray(parsed.errors)) {
        return new JobFailure('MODEL_REJECTED', `Compiler rejected the model with ${parsed.errors.length} error(s)`, false, { compileErrors: parsed.errors, compilerExitCode: 1, chtConfStatus: 'NOT_RUN', failureKind: 'COMPILER_REJECTED' });
      }
    } catch { /* falls through to the infrastructure failure below */ }
  }
  return new JobFailure('COMPILE_INFRA_ERROR', `Compile stage exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`, true,
    result.exitCode === 2 ? { compilerExitCode: 2, failureKind: 'COMPILER_USAGE_OR_FILE_ERROR' } : {});
}

// run-convert.sh writes convert.log before cht runs, so its absence means the container
// or script never got that far. Docker reserves 125-127 and signals use 128+.
export function classifyConvert(result: StageResult, hasConvertLog: boolean): JobFailure | undefined {
  if (result.timedOut) return new JobFailure('TIMEOUT', 'Convert stage timed out', true, { ...CONVERT_FAILED_FIELDS, failureKind: 'TIMED_OUT' });
  if (result.exitCode === 0) return undefined;
  if (result.exitCode >= 125 || !hasConvertLog) {
    return new JobFailure('COMPILE_INFRA_ERROR', `Convert stage exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`, true, { ...CONVERT_FAILED_FIELDS, failureKind: 'RUNNER_FAILED' });
  }
  return new JobFailure('CONVERT_FAILED', `cht-conf rejected the generated project (exit ${result.exitCode})`, false, { ...CONVERT_FAILED_FIELDS, failureKind: 'CHT_CONVERSION_FAILED' });
}

// The fields the runner reads. The schema is R6's verification-report.schema.json, copied
// verbatim from the pinned verifier commit (VERIFIER_COMMIT); update them together.
interface VerificationReport {
  version: string;
  passed: boolean;
  coverageComplete: boolean;
  testedDirHash: string;
  packageHash: string | null;
  compileArtifactHash: string;
}

const validateReport = new Ajv2020({ strict: false, validateFormats: false, allErrors: true })
  .compile(JSON.parse(readFileSync(new URL('./verification-report.schema.json', import.meta.url), 'utf8')) as object);

function parseReport(bytes: Buffer): VerificationReport | undefined {
  try {
    const report: unknown = JSON.parse(bytes.toString('utf8'));
    return validateReport(report) ? report as VerificationReport : undefined;
  } catch {
    return undefined;
  }
}

export class Worker {
  readonly #d: WorkerDeps;
  readonly #now: () => number;

  constructor(deps: WorkerDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
  }

  #log(level: 'info' | 'error', message: string, detail?: unknown): void {
    this.#d.log?.(level, message, detail);
  }

  async handle(message: QueueMessage): Promise<Outcome> {
    const { config, store, queue } = this.#d;
    const raw = decodeBody(message.body);
    const jobId = (raw as { jobId?: unknown } | undefined)?.jobId;
    const validated = validatePayload(raw);
    if ('error' in validated) {
      // Without a jobId there is no job to fail; the redrive policy moves it to the DLQ.
      if (typeof jobId !== 'string' || !jobId) {
        this.#log('error', 'Unattributable invalid message', { messageId: message.messageId });
        return 'LEFT_ON_QUEUE';
      }
      const requestId = (raw as { requestId?: unknown }).requestId;
      const at = new Date(this.#now()).toISOString();
      const recorded = await store.failUnleased(jobId, typeof requestId === 'string' ? requestId : undefined, runnerActorId(config.workerId, (raw as { jobType?: unknown }).jobType), {
        contractVersion: CONTRACT_VERSION,
        jobId,
        jobType: 'COMPILE_LOGIC',
        attempt: 1,
        status: 'FAILED',
        logicModelHash: 'unavailable',
        toolVersions: {},
        startedAt: at,
        finishedAt: at,
        errorCode: 'INVALID_PAYLOAD',
        errorMessage: validated.error,
        retryable: false,
      });
      // Deleting without a recorded failure would strand the job, so redelivery or the
      // DLQ keeps it visible instead.
      if (!recorded) {
        this.#log('error', 'Invalid message not recorded on its job; leaving it on the queue', { jobId, messageId: message.messageId });
        return 'LEFT_ON_QUEUE';
      }
      await queue.delete(message);
      return 'FAILED';
    }
    const payload = validated.payload;
    // TODO(R3): DRAFT_LOGIC worker is section 9. It stays queued rather than being failed.
    if (payload.jobType === 'DRAFT_LOGIC') {
      await queue.setVisibility(message, config.retryVisibilitySeconds);
      return 'LEFT_ON_QUEUE';
    }

    const actor = runnerActorId(config.workerId, payload.jobType);
    const taken = await store.take({
      jobId: payload.jobId,
      requestId: payload.requestId,
      messageId: message.messageId,
      receiveCount: message.receiveCount,
      workerId: actor,
      leaseSeconds: config.leaseSeconds,
    });
    if (taken.kind === 'TERMINAL' || taken.kind === 'DUPLICATE_DELIVERY') {
      await queue.delete(message);
      return 'SKIPPED';
    }
    if (taken.kind === 'MISSING') {
      this.#log('error', 'No JOB META for message; leaving it for the DLQ', { jobId: payload.jobId });
      return 'LEFT_ON_QUEUE';
    }
    if (taken.kind === 'LEASED') {
      // This message is the only way to take over if the lease holder crashes, so
      // bring it back just after the lease ends instead of deleting it.
      const seconds = Math.ceil(Math.max(0, taken.leaseUntil - this.#now()) / 1000) + 5;
      await queue.setVisibility(message, Math.min(seconds, 43_200));
      return 'SKIPPED';
    }

    return this.#run(payload, message, { jobId: payload.jobId, requestId: payload.requestId, workerId: actor, attempt: taken.attempt });
  }

  async #run(payload: JobPayload | VerifyBuildPayload, message: QueueMessage, lease: LeaseRef): Promise<Outcome> {
    const { config, store, queue } = this.#d;
    const controller = new AbortController();
    let leaseLost = false;
    const beat = setInterval(() => {
      void (async () => {
        try {
          if (!await store.heartbeat(lease, config.leaseSeconds)) {
            leaseLost = true;
            controller.abort();
            return;
          }
          await queue.setVisibility(message, config.leaseSeconds + 60);
        } catch (err) {
          this.#log('error', 'Heartbeat failed', { jobId: lease.jobId, error: String(err) });
        }
      })();
    }, Math.max(1, Math.floor(config.leaseSeconds / 3)) * 1000);

    const startedAt = new Date(this.#now()).toISOString();
    const dir = join(config.workRoot, payload.jobId, `attempt-${lease.attempt}`);
    const base = {
      contractVersion: CONTRACT_VERSION,
      jobId: payload.jobId,
      jobType: payload.jobType,
      ...(payload.mode ? { mode: payload.mode } : {}),
      attempt: lease.attempt,
      logicModelHash: payload.logicModelHash,
    } as const;
    let toolVersions: JobResult['toolVersions'] = {};
    try {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      await this.#secondGuard(payload);
      const fields = payload.jobType === 'VERIFY_BUILD'
        ? await this.#verifyBuild(payload as VerifyBuildPayload, dir, lease, controller.signal, (tools) => { toolVersions = tools; })
        : await this.#compileLogic(payload, dir, lease, controller.signal, (tools) => { toolVersions = tools; });
      if (leaseLost) return 'LEASE_LOST';
      return await this.#commit(message, lease, {
        ...base, ...fields, status: 'SUCCEEDED', toolVersions, startedAt,
        finishedAt: new Date(this.#now()).toISOString(), errorCode: null, errorMessage: null,
      });
    } catch (err) {
      if (leaseLost) return 'LEASE_LOST';
      const failure = err instanceof JobFailure
        ? err
        : new JobFailure(payload.jobType === 'VERIFY_BUILD' ? 'VERIFY_ERROR' : 'COMPILE_INFRA_ERROR', String(err).slice(0, 500), true);
      // Only the last permitted delivery is terminal, so retries can't strand a job in
      // PENDING after SQS moves the message to the DLQ.
      if (failure.retryable && message.receiveCount < config.maxReceiveCount) {
        if (!await store.releaseForRetry(lease, failure.code, failure.message)) return 'LEASE_LOST';
        await queue.setVisibility(message, config.retryVisibilitySeconds);
        return 'RETRYING';
      }
      const compileDefaults = payload.jobType === 'COMPILE_LOGIC'
        ? { compilerExitCode: null, chtConfStatus: 'NOT_RUN', failureKind: 'RUNNER_FAILED' } as const
        : {};
      return await this.#commit(message, lease, {
        ...base, ...compileDefaults, ...failure.fields, status: 'FAILED', retryable: failure.retryable, toolVersions, startedAt,
        finishedAt: new Date(this.#now()).toISOString(), errorCode: failure.code, errorMessage: failure.message,
      });
    } finally {
      clearInterval(beat);
      // Containers may leave uid 1000 files this user can't remove. The result is already
      // recorded, so a failed cleanup must not change the job's outcome.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        this.#log('error', 'Could not clean the attempt directory', { dir, error: String(err) });
      }
    }
  }

  async #commit(message: QueueMessage, lease: LeaseRef, result: JobResult): Promise<Outcome> {
    if (!validateJobResult(result)) throw new Error(`Runner built an invalid JobResult: ${errorsText(validateJobResult.errors)}`);
    if (!await this.#d.store.commitResult(lease, result)) return 'LEASE_LOST';
    await this.#d.queue.delete(message);
    return result.status;
  }

  async #secondGuard(payload: JobPayload): Promise<void> {
    if (payload.mode !== 'approved') return;
    const approval = await this.#d.store.getApproval(payload.requestId, payload.clinicalApprovalId ?? '');
    const valid = approval
      && approval.decision === 'approved'
      && approval.superseded !== true
      && approval.status !== 'SUPERSEDED'
      && typeof approval.logicModelHash === 'string'
      && hexOf(approval.logicModelHash) === hexOf(payload.logicModelHash);
    if (!valid) throw new JobFailure('APPROVAL_INVALID', 'Clinical approval is missing, not approved, superseded, or for different logic', false);
  }

  #prefix(payload: JobPayload, attempt: number): string {
    const root = payload.mode === 'preview' ? 'previews' : 'builds';
    return `${root}/${payload.logicModelHash}/${payload.jobId}/attempt-${attempt}`;
  }

  async #fetch(uri: string, what: string, code: JobErrorCode): Promise<Buffer> {
    try {
      return await this.#d.artifacts.get(uri);
    } catch (err) {
      throw new JobFailure(code, `Could not fetch ${what}: ${String(err).slice(0, 300)}`, true);
    }
  }

  // Containers run as uid 1000, which needn't match the host user that created the dirs.
  #writable(path: string): string {
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0o777);
    return path;
  }

  async #prepareBaseline(uri: string, dir: string): Promise<string> {
    checkOwnBucket(uri, this.#d.config.bucket, 'baselineUri');
    const prefix = uri.replace(/\/+$/, '');
    const manifestBytes = await this.#fetch(`${prefix}/manifest.json`, 'baseline manifest', 'COMPILE_INFRA_ERROR');
    let stored: { path: string; sha256: string }[];
    try {
      stored = (JSON.parse(manifestBytes.toString('utf8')) as { files: { path: string; sha256: string }[] }).files;
    } catch {
      throw new JobFailure('HASH_MISMATCH', 'Baseline manifest.json is not valid', false);
    }
    const baselineDir = join(dir, 'baseline');
    mkdirSync(baselineDir, { recursive: true });
    for (const name of ['compile-manifest.json', 'compile-rows.json']) {
      const expected = Array.isArray(stored) ? stored.find((file) => file.path === name)?.sha256 : undefined;
      if (!expected) throw new JobFailure('HASH_MISMATCH', `Baseline manifest does not list ${name}`, false);
      const bytes = await this.#fetch(`${prefix}/${name}`, `baseline ${name}`, 'COMPILE_INFRA_ERROR');
      if (sha256(bytes) !== expected) throw new JobFailure('HASH_MISMATCH', `Baseline ${name} does not match its stored hash`, false);
      writeFileSync(join(baselineDir, name), bytes);
    }
    return baselineDir;
  }

  // Checks the stored snapshot against the job, and writes the bytes the compiler hashes
  // as inputHash to <dir>/in/logic.json. Both job types use this.
  async #prepareLogic(payload: JobPayload, dir: string, fetchErrorCode: JobErrorCode): Promise<{ inDir: string; expectedInputHash: string }> {
    checkOwnBucket(payload.snapshotUri, this.#d.config.bucket, 'snapshotUri');
    const envelopeBytes = await this.#fetch(payload.snapshotUri, 'snapshot', fetchErrorCode);
    if (sha256(envelopeBytes) !== hexOf(payload.logicModelHash)) {
      throw new JobFailure('HASH_MISMATCH', 'Snapshot bytes do not match logicModelHash', false);
    }
    let content: unknown;
    try {
      content = (JSON.parse(envelopeBytes.toString('utf8')) as { content?: unknown }).content;
    } catch {
      throw new JobFailure('HASH_MISMATCH', 'Snapshot is not valid JSON', false);
    }
    if (!content || typeof content !== 'object') throw new JobFailure('HASH_MISMATCH', 'Snapshot has no content object', false);
    const logicBytes = canonicalJson(content);
    const inDir = join(dir, 'in');
    mkdirSync(inDir);
    chmodSync(inDir, 0o755);
    writeFileSync(join(inDir, 'logic.json'), logicBytes);
    return { inDir, expectedInputHash: sha256(logicBytes) };
  }

  async #compileLogic(
    payload: JobPayload,
    dir: string,
    lease: LeaseRef,
    signal: AbortSignal,
    setTools: (tools: JobResult['toolVersions']) => void,
  ): Promise<Partial<JobResult>> {
    const { config, artifacts, stages } = this.#d;
    const timeoutMs = config.buildTimeoutSeconds * 1000;
    const { inDir, expectedInputHash } = await this.#prepareLogic(payload, dir, 'COMPILE_INFRA_ERROR');
    const baselineDir = payload.baselineUri ? await this.#prepareBaseline(payload.baselineUri, dir) : undefined;

    setTools({
      compileImageDigest: await stages.imageDigest(config.compileImage),
      buildImageDigest: await stages.imageDigest(config.buildImage),
      compiler: config.compilerCommit,
      compilerCommit: config.compilerCommit,
      chtConf: config.chtConfVersion,
    });

    const outDir = this.#writable(join(dir, 'out'));
    const compile = await stages.compile({
      image: config.compileImage,
      inDir,
      templateDir: config.templateDir,
      compilerDir: config.compilerDir,
      outDir,
      snapshotHash: payload.logicModelHash,
      ...(payload.mode === 'preview' ? { watermark: 'PREVIEW - NOT FOR RELEASE' } : {}),
      ...(baselineDir ? { baselineDir } : {}),
      ...(payload.taskWindow ? { taskWindow: payload.taskWindow } : {}),
    }, signal, timeoutMs);
    const compileFailure = classifyCompile(compile);
    if (compileFailure) throw compileFailure;

    const workDir = this.#writable(join(dir, 'work'));
    cpSync(outDir, workDir, { recursive: true, verbatimSymlinks: true });
    execFileSync('chmod', ['-R', 'a+rwX', workDir]);

    const convert = await stages.convert({ image: config.buildImage, workDir }, signal, timeoutMs);
    const convertLogPath = join(workDir, 'convert.log');
    const hasConvertLog = existsSync(convertLogPath);
    const convertLog = hasConvertLog ? readFileSync(convertLogPath) : Buffer.from(convert.stderr);
    const compileLog = `${compile.stdout}${compile.stderr}`;
    const prefix = this.#prefix(payload, lease.attempt);
    const { uri: logUri } = await artifacts.put(`${prefix}/convert.log`, convertLog);
    await artifacts.put(`${prefix}/compile.log`, compileLog);
    const convertFailure = classifyConvert(convert, hasConvertLog);
    if (convertFailure) {
      throw new JobFailure(convertFailure.code, convertFailure.message, convertFailure.retryable, { ...convertFailure.fields, logUri });
    }

    let manifest: { snapshotHash?: unknown; inputHash?: unknown; artifactHash?: unknown; formId?: unknown; template?: { hash?: unknown } | null };
    try {
      manifest = JSON.parse(readFileSync(join(workDir, 'compile-manifest.json'), 'utf8')) as typeof manifest;
    } catch (err) {
      throw new JobFailure('COMPILE_INFRA_ERROR', `compile-manifest.json unreadable: ${String(err).slice(0, 200)}`, true, { ...AFTER_CONVERT, failureKind: 'RUNNER_FAILED', logUri });
    }
    if (manifest.inputHash !== expectedInputHash || manifest.snapshotHash !== payload.logicModelHash) {
      throw new JobFailure('INPUT_HASH_MISMATCH', 'compile-manifest.json inputHash or snapshotHash does not match this job', false, { ...AFTER_CONVERT, failureKind: 'RUNNER_FAILED', logUri });
    }

    const built = buildManifest(workDir, { 'compile.log': compileLog, 'convert.log': convertLog });
    const tgz = deterministicTgz(workDir);
    const storedPackage = await artifacts.put(`${prefix}/project.tgz`, tgz);
    const storedManifest = await artifacts.put(`${prefix}/manifest.json`, built.bytes);
    // The compile report R2 binds to is compile-manifest.json.
    const compileReportBytes = readFileSync(join(workDir, 'compile-manifest.json'));
    const storedCompileReport = await artifacts.put(`${prefix}/compile-manifest.json`, compileReportBytes);
    for (const file of built.manifest.files) {
      const isForm = posix.dirname(file.path) === 'forms/app' && /\.(xlsx|xml)$/.test(file.path);
      if (isForm || file.path === 'compile-rows.json') {
        await artifacts.put(`${prefix}/${file.path}`, readFileSync(join(workDir, file.path)));
      }
    }
    const diffPath = join(workDir, 'compile-diff.json');
    const compileDiffUri = baselineDir && existsSync(diffPath)
      ? (await artifacts.put(`${prefix}/compile-diff.json`, readFileSync(diffPath))).uri
      : undefined;

    return {
      ...AFTER_CONVERT,
      snapshotHash: String(manifest.snapshotHash),
      inputHash: String(manifest.inputHash),
      compileArtifactHash: String(manifest.artifactHash),
      templateHash: String(manifest.template?.hash),
      manifestHash: built.manifestHash,
      manifestUri: storedManifest.uri,
      ...versionField('manifestVersionId', storedManifest),
      packageHash: sha256(tgz),
      packageUri: storedPackage.uri,
      ...versionField('packageVersionId', storedPackage),
      compileReportUri: storedCompileReport.uri,
      compileReportHash: sha256(compileReportBytes),
      ...versionField('compileReportVersionId', storedCompileReport),
      logUri,
      ...(compileDiffUri ? { compileDiffUri } : {}),
    };
  }

  async #verifyBuild(
    payload: VerifyBuildPayload,
    dir: string,
    lease: LeaseRef,
    signal: AbortSignal,
    setTools: (tools: JobResult['toolVersions']) => void,
  ): Promise<Partial<JobResult>> {
    const { config, artifacts, stages } = this.#d;
    checkOwnBucket(payload.packageUri, config.bucket, 'packageUri');
    const tgz = await this.#fetch(payload.packageUri, 'package', 'VERIFY_ERROR');
    if (sha256(tgz) !== hexOf(payload.packageHash)) {
      throw new JobFailure('HASH_MISMATCH', 'Downloaded project.tgz does not match packageHash', false);
    }
    const projectDir = join(dir, 'project');
    mkdirSync(projectDir);
    const tgzPath = join(dir, 'project.tgz');
    writeFileSync(tgzPath, tgz);
    execFileSync('tar', ['-xzf', tgzPath, '-C', projectDir, '--no-same-owner']);
    execFileSync('chmod', ['-R', 'a+rX', projectDir]);

    const { inDir, expectedInputHash } = await this.#prepareLogic(payload, dir, 'VERIFY_ERROR');
    let manifest: { inputHash?: unknown; snapshotHash?: unknown };
    try {
      manifest = JSON.parse(readFileSync(join(projectDir, 'compile-manifest.json'), 'utf8')) as typeof manifest;
    } catch (err) {
      throw new JobFailure('INPUT_HASH_MISMATCH', `Package has no readable compile-manifest.json: ${String(err).slice(0, 200)}`, false);
    }
    if (manifest.inputHash !== expectedInputHash || typeof manifest.snapshotHash !== 'string' || hexOf(manifest.snapshotHash) !== hexOf(payload.logicModelHash)) {
      throw new JobFailure('INPUT_HASH_MISMATCH', 'Package compile-manifest.json does not match the job snapshot', false);
    }

    let goldenCasesHash: string | undefined;
    if (payload.goldenCasesUri) {
      checkOwnBucket(payload.goldenCasesUri, config.bucket, 'goldenCasesUri');
      const golden = await this.#fetch(payload.goldenCasesUri, 'golden cases', 'VERIFY_ERROR');
      if (sha256(golden) !== hexOf(payload.goldenCasesHash ?? '')) {
        throw new JobFailure('HASH_MISMATCH', 'Golden cases do not match goldenCasesHash', false);
      }
      writeFileSync(join(inDir, 'golden-cases.json'), golden);
      goldenCasesHash = sha256(golden);
    }

    setTools({ buildImageDigest: await stages.imageDigest(config.buildImage), verifierCommit: config.verifierCommit, chtConf: config.chtConfVersion });

    const outDir = this.#writable(join(dir, 'out'));
    // Bare hex: R6 echoes these into the report, and R2 compares them to its raw hex.
    const run = await stages.verify({
      image: config.buildImage,
      projectDir,
      inDir,
      verifierDir: config.verifierDir,
      outDir,
      packageHash: hexOf(payload.packageHash),
      compileArtifactHash: hexOf(payload.compileArtifactHash),
      logicModelHash: hexOf(payload.logicModelHash),
      inputHash: expectedInputHash,
      ...(goldenCasesHash ? { goldenCasesHash } : {}),
    }, signal, config.buildTimeoutSeconds * 1000);
    if (run.timedOut) throw new JobFailure('TIMEOUT', 'Verify stage timed out', true);

    const prefix = this.#prefix(payload, lease.attempt);
    const logPath = join(outDir, 'verification.log');
    const { uri: logUri } = await artifacts.put(`${prefix}/verification.log`, existsSync(logPath) ? readFileSync(logPath) : `${run.stdout}${run.stderr}`);

    const reportPath = join(outDir, 'report.json');
    const reportBytes = existsSync(reportPath) ? readFileSync(reportPath) : undefined;
    const report = reportBytes ? parseReport(reportBytes) : undefined;
    if ((run.exitCode !== 0 && run.exitCode !== 1) || !report || !reportBytes) {
      throw new JobFailure('VERIFY_ERROR', `Verifier exited ${run.exitCode} without a valid report`, true, { logUri });
    }
    const mismatch = report.passed !== (run.exitCode === 0) ? 'report.passed disagrees with the exit code'
      : hexOf(report.packageHash ?? '') !== hexOf(payload.packageHash) ? 'report.packageHash does not match the job'
      : hexOf(report.compileArtifactHash) !== hexOf(payload.compileArtifactHash) ? 'report.compileArtifactHash does not match the job'
      : undefined;
    if (mismatch) throw new JobFailure('VERIFY_ERROR', mismatch, false, { logUri });

    const storedReport = await artifacts.put(`${prefix}/report.json`, reportBytes);
    return {
      packageHash: payload.packageHash,
      packageUri: payload.packageUri,
      manifestHash: payload.manifestHash,
      compileArtifactHash: payload.compileArtifactHash,
      reportUri: storedReport.uri,
      ...versionField('reportVersionId', storedReport),
      reportHash: sha256(reportBytes),
      verificationPassed: report.passed,
      coverageComplete: report.coverageComplete,
      testedDirHash: report.testedDirHash,
      reportVersion: report.version,
      logUri,
    };
  }
}
