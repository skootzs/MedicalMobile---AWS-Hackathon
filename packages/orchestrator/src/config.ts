/**
 * Production configuration loader for the orchestrator composition root.
 *
 * Reads and validates environment configuration ONCE at startup and fails
 * closed: an invalid or incomplete configuration throws, so the process never
 * boots into a half-configured state. Keys and the MODE semantics mirror R7's
 * published .env.example on the r7-infra branch (AWS_REGION, DDB_TABLE,
 * ARTIFACT_BUCKET, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, MODE=aws|local).
 *
 * This module holds NO secrets and constructs NO AWS resource names. Every
 * value is supplied by the operator's environment; nothing is defaulted to a
 * real AWS identifier.
 */

/** R7 hard constraint (infra/terraform/variables.tf): us-west-2 only. */
export const REQUIRED_AWS_REGION = 'us-west-2' as const;

export type RunMode = 'aws' | 'local';

export interface AwsConfig {
  readonly mode: 'aws';
  readonly region: string;
  readonly ddbTable: string;
  readonly artifactBucket: string;
  readonly cognito: { readonly userPoolId: string; readonly clientId: string };
  readonly host: string;
  readonly port: number;
}
export interface LocalConfig {
  readonly mode: 'local';
  /** DynamoDB Local endpoint; must be loopback http:// (never a real AWS host). */
  readonly dynamoEndpoint: string;
  readonly ddbTable: string;
  /** Directory backing the durable local object provider (stands in for S3). */
  readonly objectDirectory: string;
  readonly host: string;
  readonly port: number;
}
export type OrchestratorConfig = AwsConfig | LocalConfig;

export class ConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError('MISSING_CONFIG', `Required environment variable ${key} is missing or empty.`);
  }
  return value.trim();
}

function optional(env: Env, key: string, fallback: string): string {
  const value = env[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError('INVALID_PORT', `PORT must be an integer between 1 and 65535, received ${JSON.stringify(value)}.`);
  }
  return port;
}

function parseMode(env: Env): RunMode {
  const raw = optional(env, 'MODE', 'local');
  if (raw !== 'aws' && raw !== 'local') {
    throw new ConfigError('INVALID_MODE', `MODE must be "aws" or "local", received ${JSON.stringify(raw)}.`);
  }
  return raw;
}

function loadAws(env: Env): AwsConfig {
  // Fail closed: AWS mode demands every durable-storage and identity input.
  const region = required(env, 'AWS_REGION');
  if (region !== REQUIRED_AWS_REGION) {
    throw new ConfigError('INVALID_REGION', `AWS_REGION must be ${REQUIRED_AWS_REGION} (R7 hard constraint), received ${JSON.stringify(region)}.`);
  }
  return Object.freeze({
    mode: 'aws',
    region,
    ddbTable: required(env, 'DDB_TABLE'),
    artifactBucket: required(env, 'ARTIFACT_BUCKET'),
    cognito: Object.freeze({
      userPoolId: required(env, 'COGNITO_USER_POOL_ID'),
      clientId: required(env, 'COGNITO_CLIENT_ID'),
    }),
    host: optional(env, 'HOST', '0.0.0.0'),
    port: parsePort(optional(env, 'PORT', '8080')),
  });
}

function loadLocal(env: Env): LocalConfig {
  // The local demo still uses the REAL DynamoDB adapter and durable object
  // provider against DynamoDB Local; it never falls back to in-memory storage.
  const endpoint = required(env, 'R2_DYNAMODB_LOCAL_ENDPOINT');
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new ConfigError('INVALID_ENDPOINT', `R2_DYNAMODB_LOCAL_ENDPOINT is not a valid URL: ${JSON.stringify(endpoint)}.`); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) {
    throw new ConfigError('INVALID_ENDPOINT', 'R2_DYNAMODB_LOCAL_ENDPOINT must be a loopback http:// endpoint for local mode.');
  }
  return Object.freeze({
    mode: 'local',
    dynamoEndpoint: endpoint,
    ddbTable: optional(env, 'DDB_TABLE', 'cht-nocode-local'),
    objectDirectory: required(env, 'R2_OBJECT_DIR'),
    host: optional(env, 'HOST', '127.0.0.1'),
    port: parsePort(optional(env, 'PORT', '8080')),
  });
}

/**
 * Load and validate configuration from an environment map (defaults to
 * process.env). Throws ConfigError on any invalid or missing value. Never
 * returns a partially-populated config.
 */
export function loadConfig(env: Env = process.env): OrchestratorConfig {
  return parseMode(env) === 'aws' ? loadAws(env) : loadLocal(env);
}
