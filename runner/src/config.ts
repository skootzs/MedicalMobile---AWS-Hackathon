export interface RunnerConfig {
  region: string;
  table: string;
  bucket: string;
  jobsQueueUrl: string;
  workerId: string;
  leaseSeconds: number;
  buildTimeoutSeconds: number;
  maxReceiveCount: number;
  retryVisibilitySeconds: number;
  compileImage: string;
  buildImage: string;
  compilerDir: string;
  compilerCommit: string;
  templateDir: string;
  verifierDir: string;
  verifierCommit: string;
  chtConfVersion: string;
  workRoot: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  return {
    region: required(env, 'AWS_REGION'),
    table: required(env, 'DDB_TABLE'),
    bucket: required(env, 'ARTIFACT_BUCKET'),
    jobsQueueUrl: required(env, 'JOBS_QUEUE_URL'),
    workerId: required(env, 'WORKER_ID'),
    leaseSeconds: positiveInt(env, 'LEASE_SECONDS', 900),
    buildTimeoutSeconds: positiveInt(env, 'BUILD_TIMEOUT_SECONDS', 600),
    maxReceiveCount: positiveInt(env, 'MAX_RECEIVE_COUNT', 3),
    retryVisibilitySeconds: positiveInt(env, 'RETRY_VISIBILITY_SECONDS', 30),
    compileImage: required(env, 'COMPILE_IMAGE'),
    buildImage: required(env, 'BUILD_IMAGE'),
    compilerDir: required(env, 'COMPILER_DIR'),
    compilerCommit: required(env, 'COMPILER_COMMIT'),
    templateDir: required(env, 'TEMPLATE_DIR'),
    verifierDir: required(env, 'VERIFIER_DIR'),
    verifierCommit: required(env, 'VERIFIER_COMMIT'),
    // Matches the pin in build-image/Dockerfile.
    chtConfVersion: env.CHT_CONF_VERSION || '6.6.1',
    workRoot: required(env, 'RUNNER_WORK_DIR'),
  };
}
