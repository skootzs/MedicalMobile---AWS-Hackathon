import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError, REQUIRED_AWS_REGION } from '../src/config.ts';

const awsEnv = () => ({
  MODE: 'aws', AWS_REGION: REQUIRED_AWS_REGION, DDB_TABLE: 'cht-nocode',
  ARTIFACT_BUCKET: 'cht-nocode-artifacts-abc', COGNITO_USER_POOL_ID: 'us-west-2_fictional',
  COGNITO_CLIENT_ID: 'fictionalclient', PORT: '8080',
});
const localEnv = () => ({
  MODE: 'local', R2_DYNAMODB_LOCAL_ENDPOINT: 'http://localhost:8000', R2_OBJECT_DIR: '/tmp/r2-demo',
});

test('defaults to local mode when MODE is unset', () => {
  const config = loadConfig({ R2_DYNAMODB_LOCAL_ENDPOINT: 'http://127.0.0.1:8000', R2_OBJECT_DIR: '/tmp/x' });
  assert.equal(config.mode, 'local');
});

test('AWS mode loads every required durable-storage and identity value', () => {
  const config = loadConfig(awsEnv());
  assert.equal(config.mode, 'aws');
  if (config.mode !== 'aws') return;
  assert.equal(config.ddbTable, 'cht-nocode');
  assert.equal(config.artifactBucket, 'cht-nocode-artifacts-abc');
  assert.equal(config.cognito.userPoolId, 'us-west-2_fictional');
  assert.equal(config.cognito.clientId, 'fictionalclient');
  assert.equal(config.port, 8080);
});

test('AWS mode fails closed when any required value is missing', () => {
  for (const key of ['AWS_REGION', 'DDB_TABLE', 'ARTIFACT_BUCKET', 'COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID']) {
    const env = awsEnv() as Record<string, string | undefined>;
    delete env[key];
    assert.throws(() => loadConfig(env), (e: unknown) => e instanceof ConfigError && e.code === 'MISSING_CONFIG', `missing ${key} should throw`);
  }
});

test('AWS mode enforces the R7 region constraint', () => {
  assert.throws(() => loadConfig({ ...awsEnv(), AWS_REGION: 'us-east-1' }),
    (e: unknown) => e instanceof ConfigError && e.code === 'INVALID_REGION');
});

test('invalid MODE is rejected', () => {
  assert.throws(() => loadConfig({ MODE: 'production' }), (e: unknown) => e instanceof ConfigError && e.code === 'INVALID_MODE');
});

test('invalid PORT is rejected', () => {
  assert.throws(() => loadConfig({ ...awsEnv(), PORT: '70000' }), (e: unknown) => e instanceof ConfigError && e.code === 'INVALID_PORT');
  assert.throws(() => loadConfig({ ...awsEnv(), PORT: 'abc' }), (e: unknown) => e instanceof ConfigError && e.code === 'INVALID_PORT');
});

test('local mode requires a loopback http endpoint and an object directory', () => {
  const config = loadConfig(localEnv());
  assert.equal(config.mode, 'local');
  if (config.mode !== 'local') return;
  assert.equal(config.objectDirectory, '/tmp/r2-demo');
  assert.throws(() => loadConfig({ ...localEnv(), R2_DYNAMODB_LOCAL_ENDPOINT: 'https://dynamodb.us-west-2.amazonaws.com' }),
    (e: unknown) => e instanceof ConfigError && e.code === 'INVALID_ENDPOINT');
  const noDir = localEnv() as Record<string, string | undefined>;
  delete noDir.R2_OBJECT_DIR;
  assert.throws(() => loadConfig(noDir), (e: unknown) => e instanceof ConfigError && e.code === 'MISSING_CONFIG');
});
