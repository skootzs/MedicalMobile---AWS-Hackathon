import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { RunnerConfig } from '../src/config.ts';
import { documentClient } from '../src/ddb.ts';
import { canonicalJson, sha256 } from '../src/hashing.ts';
import { JobStore } from '../src/store.ts';
import { Worker, type Artifacts, type Outcome, type Queue, type QueueMessage } from '../src/worker.ts';
import { CONTRACT_VERSION } from '../src/generated/handoffs.ts';
import type { StageResult, Stages } from '../launch-build.ts';

// Always local: these tests must never reach the live table, whatever .env holds.
const ENDPOINT = process.env.DYNAMODB_LOCAL_ENDPOINT ?? 'http://localhost:8000';
const TABLE = 'cht-nocode-runner-test';
const here = dirname(fileURLToPath(import.meta.url));

export function createTable(): DynamoDBDocumentClient {
  execFileSync(join(here, '../../scripts/dynamodb-local/create-table.sh'), {
    env: { ...process.env, DYNAMODB_LOCAL_ENDPOINT: ENDPOINT, DDB_TABLE: TABLE, AWS_ACCESS_KEY_ID: 'local', AWS_SECRET_ACCESS_KEY: 'local' },
    stdio: 'pipe',
  });
  return documentClient(new DynamoDBClient({
    endpoint: ENDPOINT,
    region: 'us-west-2',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  }));
}

export const BUCKET = 'test-bucket';
export const OK: StageResult = { exitCode: 0, stdout: '{"ok":true}', stderr: '', timedOut: false, aborted: false };

export const LOGIC = { schemaVersion: 'test', questions: [{ id: 'b', type: 'boolean' }], a: 1 };
export const ENVELOPE = Buffer.from(canonicalJson({ kind: 'LOGIC_MODEL', revision: 1, content: LOGIC }));
export const LOGIC_HASH = `sha256:${sha256(ENVELOPE)}`;
export const INPUT_HASH = sha256(canonicalJson(LOGIC));
export const ARTIFACT_HASH = sha256('art');

export class FakeQueue implements Queue {
  deleted: string[] = [];
  visibility: number[] = [];
  async delete(message: QueueMessage) { this.deleted.push(message.messageId); }
  async setVisibility(_message: QueueMessage, seconds: number) { this.visibility.push(seconds); }
}

export class FakeArtifacts implements Artifacts {
  objects = new Map<string, Buffer>();
  seed(key: string, body: string | Buffer) { this.objects.set(key, Buffer.from(body)); return `s3://${BUCKET}/${key}`; }
  async get(uri: string) {
    const key = uri.replace(`s3://${BUCKET}/`, '');
    const found = this.objects.get(key);
    if (!found) throw new Error(`NoSuchKey ${key}`);
    return found;
  }
  async put(key: string, body: string | Buffer) { return { uri: this.seed(key, body), versionId: `v-${key}` }; }
}

// Plays the compiler and cht-conf contract without containers. Override per test.
export class FakeStages implements Stages {
  calls: string[] = [];
  compileInputs: Parameters<Stages['compile']>[0][] = [];
  manifestOverride: Record<string, unknown> = {};
  compileResult: StageResult = OK;
  convertResult: StageResult = OK;
  verifyResult: StageResult = OK;
  verifyInputs: Parameters<Stages['verify']>[0][] = [];
  verifyFiles: Record<string, string>[] = [];
  writeConvertLog = true;
  report: unknown = undefined;
  onCompile: (() => void) | undefined;

  async compile(input: Parameters<Stages['compile']>[0]) {
    this.calls.push('compile');
    this.compileInputs.push(input);
    this.onCompile?.();
    if (this.compileResult.exitCode !== 0) return this.compileResult;
    const logic = readFileSync(join(input.inDir, 'logic.json'), 'utf8');
    mkdirSync(join(input.outDir, 'forms/app'), { recursive: true });
    writeFileSync(join(input.outDir, 'forms/app/f.xlsx'), 'xlsx');
    writeFileSync(join(input.outDir, 'compile-rows.json'), '[]');
    writeFileSync(join(input.outDir, 'compile-manifest.json'), JSON.stringify({
      formId: 'f', snapshotHash: input.snapshotHash, inputHash: sha256(logic), artifactHash: ARTIFACT_HASH, template: { hash: 'tpl' }, ...this.manifestOverride,
    }));
    if (input.baselineDir) writeFileSync(join(input.outDir, 'compile-diff.json'), '{"identical":true}');
    return this.compileResult;
  }
  async convert(input: Parameters<Stages['convert']>[0]) {
    this.calls.push('convert');
    if (this.writeConvertLog) writeFileSync(join(input.workDir, 'convert.log'), 'log');
    if (this.convertResult.exitCode !== 0) return this.convertResult;
    writeFileSync(join(input.workDir, 'forms/app/f.xml'), '<xml/>');
    writeFileSync(join(input.workDir, 'app_settings.json'), '{}');
    mkdirSync(join(input.workDir, 'shiv'), { recursive: true });
    writeFileSync(join(input.workDir, 'shiv/cache'), String(Math.random()));
    // Like cht-conf's eslint cache, which differs on every run.
    mkdirSync(join(input.workDir, 'node_modules/.cache/eslint-webpack-plugin'), { recursive: true });
    writeFileSync(join(input.workDir, 'node_modules/.cache/eslint-webpack-plugin/.eslintcache'), String(Math.random()));
    return this.convertResult;
  }
  async verify(input: Parameters<Stages['verify']>[0]) {
    this.calls.push('verify');
    this.verifyInputs.push(input);
    this.verifyFiles.push(Object.fromEntries(readdirSync(input.inDir).map((name) => [name, readFileSync(join(input.inDir, name), 'utf8')])));
    if (!existsSync(join(input.projectDir, 'app_settings.json'))) throw new Error('package was not unpacked');
    if (this.report !== undefined) writeFileSync(join(input.outDir, 'report.json'), JSON.stringify(this.report));
    return this.verifyResult;
  }
  async imageDigest(image: string) { return `${image}@sha256:test`; }
  cleanupCalls: string[] = [];
  onCleanup: ((dir: string) => void) | undefined;
  async removeContainerFiles(dir: string) {
    this.cleanupCalls.push(dir);
    this.onCleanup?.(dir);
  }
}

let messageCounter = 0;

export class Harness {
  readonly db: DynamoDBDocumentClient;
  now = Date.now();
  queue = new FakeQueue();
  artifacts = new FakeArtifacts();
  stages = new FakeStages();
  readonly workRoot = mkdtempSync(join(tmpdir(), 'runner-test-'));
  readonly snapshotUri: string;

  constructor(db: DynamoDBDocumentClient) {
    this.db = db;
    this.snapshotUri = this.artifacts.seed(`snapshots/${LOGIC_HASH}.json`, ENVELOPE);
  }

  config(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
    return {
      region: 'us-west-2', table: TABLE, bucket: BUCKET, jobsQueueUrl: 'q', workerId: 'worker-a', leaseSeconds: 900,
      buildTimeoutSeconds: 600, maxReceiveCount: 3, retryVisibilitySeconds: 30, compileImage: 'compile:1', buildImage: 'build:1',
      compilerDir: '/c', compilerCommit: '7f488e6', templateDir: '/t', verifierDir: '/v', verifierCommit: 'abc', chtConfVersion: '6.6.1', workRoot: this.workRoot,
      ...overrides,
    };
  }

  store() { return new JobStore(this.db, TABLE, () => this.now); }

  worker(overrides: Partial<RunnerConfig> = {}) {
    const config = this.config(overrides);
    return new Worker({ config, store: this.store(), queue: this.queue, artifacts: this.artifacts, stages: this.stages, now: () => this.now });
  }

  payload(overrides: Record<string, unknown> = {}) {
    const id = randomUUID();
    return {
      contractVersion: CONTRACT_VERSION, jobId: `job-${id}`, jobType: 'COMPILE_LOGIC', mode: 'preview', requestId: `req-${id}`, revision: 1,
      logicModelHash: LOGIC_HASH, snapshotUri: this.snapshotUri, checkReportHash: 'sha256:c', clinicalApprovalId: null,
      createdBy: 'po', createdAt: new Date(this.now).toISOString(), ...overrides,
    };
  }

  async seedJob(payload: { jobId: unknown; requestId: unknown }) {
    await this.db.send(new PutCommand({ TableName: TABLE, Item: { pk: `JOB#${String(payload.jobId)}`, sk: 'META', status: 'PENDING', requestId: payload.requestId } }));
  }

  async seedApproval(requestId: unknown, approvalId: string, item: Record<string, unknown>) {
    await this.db.send(new PutCommand({ TableName: TABLE, Item: { pk: `REQ#${String(requestId)}`, sk: `APPROVAL#${approvalId}`, ...item } }));
  }

  message(payload: unknown, receiveCount = 1, messageId = `m-${++messageCounter}`): QueueMessage {
    return { messageId, receiptHandle: `h-${messageId}`, receiveCount, body: JSON.stringify(payload) };
  }

  async job(jobId: unknown) {
    const found = await this.db.send(new GetCommand({ TableName: TABLE, Key: { pk: `JOB#${String(jobId)}`, sk: 'META' }, ConsistentRead: true }));
    return found.Item!;
  }

  async audits(requestId: unknown) {
    const found = await this.db.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :audit)',
      ExpressionAttributeValues: { ':pk': `REQ#${String(requestId)}`, ':audit': 'AUDIT#' },
      ConsistentRead: true,
    }));
    return (found.Items ?? []).map((item) => item.event as string);
  }

  keys() { return [...this.artifacts.objects.keys()]; }

  async run(payload: unknown, receiveCount = 1): Promise<Outcome> {
    return this.worker().handle(this.message(payload, receiveCount));
  }
}
