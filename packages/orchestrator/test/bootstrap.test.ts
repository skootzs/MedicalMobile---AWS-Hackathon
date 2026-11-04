import test from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { bootstrap } from '../src/bootstrap.ts';
import { createDemoIdentity, demoHeaders } from '../src/demo-identity.ts';
import type { OrchestratorConfig } from '../src/config.ts';
import type { DurableObjects } from '../src/storage/durable-objects.ts';

// A document client / object store that must never be touched for these tests:
// fail-closed guards reject before any storage call. If one IS called the test
// throws, proving the guard ran first.
const explodingClient = { send: () => { throw new Error('storage must not be reached'); } } as unknown as DynamoDBDocumentClient;
const explodingObjects: DurableObjects = {
  putIfAbsent: () => { throw new Error('objects must not be reached'); },
  read: () => { throw new Error('objects must not be reached'); },
};

const localConfig: OrchestratorConfig = Object.freeze({
  mode: 'local', dynamoEndpoint: 'http://localhost:8000', ddbTable: 'cht-nocode-local',
  objectDirectory: '/tmp/unused-bootstrap-test', host: '127.0.0.1', port: 0,
});
const awsConfig: OrchestratorConfig = Object.freeze({
  mode: 'aws', region: 'us-west-2', ddbTable: 'cht-nocode', artifactBucket: 'b',
  cognito: { userPoolId: 'us-west-2_x', clientId: 'c' }, host: '127.0.0.1', port: 0,
});

test('local mode refuses to boot without an explicit identity provider', () => {
  assert.throws(() => bootstrap({ config: localConfig, documentClient: explodingClient, objects: explodingObjects }),
    /Local mode requires an explicit identity provider/);
});

test('AWS mode uses verified-Cognito auth and rejects every unverified request (401)', async () => {
  const server = bootstrap({ config: awsConfig, documentClient: explodingClient, objects: explodingObjects });
  try {
    // A demo-style bearer token must NOT be accepted in AWS mode.
    const withToken = await server.app.inject({ method: 'GET', url: '/api/requests/demo-1', headers: demoHeaders('demo-po') });
    assert.equal(withToken.statusCode, 401, withToken.body);
    const noToken = await server.app.inject({ method: 'GET', url: '/api/requests/demo-1' });
    assert.equal(noToken.statusCode, 401, noToken.body);
  } finally { await server.close(); }
});

test('AWS mode S3 object storage is not fabricated: boot fails closed without an injected provider', () => {
  assert.throws(() => bootstrap({ config: awsConfig, documentClient: explodingClient }),
    /AWS-mode durable object storage \(S3\) is not implemented yet/);
});

test('local demo identity rejects unknown tokens before any storage access', async () => {
  const server = bootstrap({ config: localConfig, identity: createDemoIdentity(), documentClient: explodingClient, objects: explodingObjects });
  try {
    const unknown = await server.app.inject({ method: 'GET', url: '/api/requests/demo-1', headers: demoHeaders('not-a-demo-user') });
    assert.equal(unknown.statusCode, 401, unknown.body);
    const none = await server.app.inject({ method: 'GET', url: '/api/requests/demo-1' });
    assert.equal(none.statusCode, 401, none.body);
  } finally { await server.close(); }
});

test('local demo identity hides requests outside the demo prefix (404, not 401)', async () => {
  const server = bootstrap({ config: localConfig, identity: createDemoIdentity(), documentClient: explodingClient, objects: explodingObjects });
  try {
    // Authenticated demo PO, but requesting a non-demo id: access denied -> 404,
    // and storage is never reached (explodingClient would throw -> 503/500).
    const res = await server.app.inject({ method: 'GET', url: '/api/requests/other-1', headers: demoHeaders('demo-po') });
    assert.equal(res.statusCode, 404, res.body);
  } finally { await server.close(); }
});

test('the bootstrapped app exposes listen() (unlike the test harness)', () => {
  const server = bootstrap({ config: localConfig, identity: createDemoIdentity(), documentClient: explodingClient, objects: explodingObjects });
  assert.equal(typeof server.app.listen, 'function');
  assert.equal(typeof server.close, 'function');
  return server.close();
});
