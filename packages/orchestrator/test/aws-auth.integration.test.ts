/**
 * End-to-end AWS-mode authorization over HTTP against DynamoDB Local.
 *
 * This wires the REAL Cognito AuthenticationBoundary (aws-jwt-verify with a
 * locally-hydrated JWKS, so real RS256 signatures are checked offline) to a
 * bootstrapped server backed by DynamoDB Local + a durable local object store.
 * It proves the production auth path: a verified access token -> actor ->
 * authoritative request access -> workflow, including self-approval and
 * unauthorized-release rejection. Only S3 is substituted (local disk) because
 * no real bucket exists in this environment; the Dynamo adapter and the entire
 * Cognito verification + authorization path are exactly the production ones.
 *
 * Gated on R2_DYNAMODB_LOCAL_ENDPOINT.
 */
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap } from '../src/bootstrap.ts';
import { resolveCognitoActor } from '../src/cognito-auth.ts';
import type { OrchestratorConfig } from '../src/config.ts';
import { DynamoOrchestratorStore } from '../src/storage/dynamodb.ts';
import { LocalObjectStore } from '../src/storage/local-objects.ts';
import { localClient, createLocalTable } from './helpers/dynamodb-local-fixtures.ts';
import { provisionalSnapshotValidator } from '../src/snapshots.ts';
import { r7Layout } from '../src/storage/r7-layout.ts';
import { next } from './helpers/approval-fixtures.ts';
import { CheckerResultService } from '../src/checkers.ts';
import { FictionalChecker } from './helpers/checker-fixtures.ts';
import { resolveReviewActor } from './helpers/review-fixtures.ts';
import { createTokenHarness, TEST_USER_POOL_ID, TEST_CLIENT_ID } from './helpers/cognito-test-tokens.ts';
import type { Actor, WorkflowState, WorkflowStatus } from '../src/workflow.ts';

const endpoint = process.env.R2_DYNAMODB_LOCAL_ENDPOINT;
const integration = { skip: !endpoint };

async function setup(t: TestContext) {
  const table = `r2-local-test-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), 'r2-aws-auth-'));
  const client = localClient(endpoint!);
  await createLocalTable(client.client, table);
  const harness = createTokenHarness();

  // AWS-shaped config, but DynamoDB/S3 clients are injected (Local + disk).
  const config: OrchestratorConfig = Object.freeze({
    mode: 'aws', region: 'us-west-2', ddbTable: table, artifactBucket: 'injected',
    cognito: { userPoolId: TEST_USER_POOL_ID, clientId: TEST_CLIENT_ID }, host: '127.0.0.1', port: 0,
  });

  // Resolver handles real Cognito claims (HTTP path) AND the fixture string
  // principals used to advance the workflow (R3/R4 stand-ins).
  const resolveActor = (principal: unknown): Actor | null =>
    resolveCognitoActor(principal) ?? (typeof principal === 'string' ? resolveReviewActor(principal) : null);

  const makeStore = () => new DynamoOrchestratorStore({
    client: client.document, tableName: table, objects: new LocalObjectStore(directory),
    layout: r7Layout, resolveActor, validateSnapshot: provisionalSnapshotValidator,
  });

  // Exercise the PRODUCTION AWS path: bootstrap builds awsIdentity() itself
  // (real Cognito boundary + authoritative access), we only inject the verifier
  // (hydrated JWKS) and the Local Dynamo/disk clients.
  const makeServer = () => bootstrap({
    config, documentClient: client.document, objects: new LocalObjectStore(directory),
    cognitoVerifier: harness.makeVerifier(),
  });

  t.after(async () => { client.client.destroy(); await rm(directory, { recursive: true, force: true }); });
  return { config, harness, makeServer, makeStore };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function advance(store: DynamoOrchestratorStore, id: string, target: WorkflowStatus, ownerSub: string): Promise<WorkflowState> {
  let s = (await store.getWorkflow(id))!;
  while (s.status !== target) {
    if (s.status === 'WAITING_FOR_LOGIC_CHECKS') {
      const checker = new CheckerResultService({ store, resolveActor: (p) => resolveCognitoActor(p) ?? (typeof p === 'string' ? resolveReviewActor(p) : null),
        canAccessRequest: () => true, checker: { checkerActorId: 'fictional-checker', checkerId: 'fictional-r4-checker', checkerVersion: 'fixture-v1' } });
      const c = { requestId: id, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash, ...s.logic!, expectedVersion: s.version, eventId: `fx-auth-${s.version}` };
      const a = await checker.authorize(c, 'backend'); assert.equal(a.status, 'AUTHORIZED', a.reason);
      const snap = await store.getSnapshot({ kind: 'LOGIC_MODEL', requestId: id, revision: s.logic!.logicRevision, requestPreview: { requestId: id, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash } });
      if (snap?.kind !== 'LOGIC_MODEL') throw new Error('fixture');
      const report = await new FictionalChecker().check(a.invocation!, snap);
      assert.equal((await checker.ingest({ ...c, eventId: `fx-chk-${s.version}`, invocationId: a.invocation!.invocationId, report }, 'checker')).status, 'ACCEPTED');
    } else {
      const step = next(s);
      const who = step.who === 'po' ? { sub: ownerSub, groups: ['po'] } : step.who;
      assert.equal((await store.apply(step.cmd, who)).outcome, 'ACCEPTED');
    }
    s = (await store.getWorkflow(id))!;
  }
  return s;
}

test('AWS AUTH: a verified PO access token creates and reads its own request', integration, async (t) => {
  const f = await setup(t);
  const server = f.makeServer();
  try {
    const poToken = f.harness.mint({ sub: 'po-user', 'cognito:groups': ['po'] });
    const res = await server.app.inject({ method: 'POST', url: '/api/requests', headers: bearer(poToken),
      payload: { eventId: 'aws-create-1', expectedVersion: 0, content: {
        title: 'Fictional AWS-auth case', objective: 'Prove verified Cognito create.',
        targetPopulation: 'Fictional', requirements: [{ condition: 'x', action: 'y' }] } } });
    assert.equal(res.statusCode, 201, res.body);
    const id = res.json().requestId as string;
    // Owner can read; a DIFFERENT verified PO cannot (authoritative ownership).
    assert.equal((await server.app.inject({ method: 'GET', url: `/api/requests/${id}`, headers: bearer(poToken) })).statusCode, 200);
    const otherPo = f.harness.mint({ sub: 'other-po', 'cognito:groups': ['po'] });
    assert.equal((await server.app.inject({ method: 'GET', url: `/api/requests/${id}`, headers: bearer(otherPo) })).statusCode, 404);
    // An unverified/garbage token is rejected.
    assert.equal((await server.app.inject({ method: 'GET', url: `/api/requests/${id}`, headers: bearer('not.a.jwt') })).statusCode, 401);
  } finally { await server.close(); }
});

test('AWS AUTH: independent clinician approves; author self-approval is rejected', integration, async (t) => {
  const f = await setup(t);
  let id: string;
  const server = f.makeServer();
  try {
    const poToken = f.harness.mint({ sub: 'po-user', 'cognito:groups': ['po'] });
    const res = await server.app.inject({ method: 'POST', url: '/api/requests', headers: bearer(poToken),
      payload: { eventId: 'aws-create-2', expectedVersion: 0, content: {
        title: 'Fictional AWS approval-gate', objective: 'Prove the clinical gate under Cognito.',
        targetPopulation: 'Fictional', requirements: [{ condition: 'f', action: 'o' }] } } });
    assert.equal(res.statusCode, 201, res.body);
    id = res.json().requestId as string;
  } finally { await server.close(); }

  const pending = await advance(f.makeStore(), id, 'WAITING_FOR_CLINICAL_APPROVAL', 'po-user');
  const body = {
    eventId: 'aws-clinical', expectedVersion: pending.version, requestRevision: pending.brief.revision,
    requestSnapshotHash: pending.brief.snapshotHash, logicRevision: pending.logic!.logicRevision,
    logicHash: pending.logic!.logicHash, checkerReportId: pending.checks!.reportId, decision: 'APPROVE' as const,
  };
  const app = f.makeServer();
  try {
    // Self-approval: a clinician token whose sub is the request OWNER is rejected.
    const selfToken = f.harness.mint({ sub: 'po-user', 'cognito:groups': ['po', 'clinician'] });
    assert.equal((await app.app.inject({ method: 'POST', url: `/api/requests/${id}/clinical-decisions`, headers: bearer(selfToken), payload: { ...body, eventId: 'aws-self' } })).statusCode, 403);
    // Unauthenticated is blocked.
    assert.equal((await app.app.inject({ method: 'POST', url: `/api/requests/${id}/clinical-decisions`, payload: body })).statusCode, 401);
    // Independent clinician approves.
    const clinToken = f.harness.mint({ sub: 'clin-user', 'cognito:groups': ['clinician'] });
    assert.equal((await app.app.inject({ method: 'POST', url: `/api/requests/${id}/clinical-decisions`, headers: bearer(clinToken), payload: body })).statusCode, 200);
    assert.equal((await f.makeStore().getWorkflow(id))?.status, 'CLINICALLY_APPROVED');
  } finally { await app.close(); }
});

test('AWS AUTH: a release approver cannot access a request still at clinical stage', integration, async (t) => {
  const f = await setup(t);
  let id: string;
  const server = f.makeServer();
  try {
    const poToken = f.harness.mint({ sub: 'po-user', 'cognito:groups': ['po'] });
    const res = await server.app.inject({ method: 'POST', url: '/api/requests', headers: bearer(poToken),
      payload: { eventId: 'aws-create-3', expectedVersion: 0, content: {
        title: 'Fictional release-scope', objective: 'Prove reviewer scope.',
        targetPopulation: 'Fictional', requirements: [{ condition: 'f', action: 'o' }] } } });
    id = res.json().requestId as string;
  } finally { await server.close(); }

  await advance(f.makeStore(), id, 'WAITING_FOR_CLINICAL_APPROVAL', 'po-user');
  const app = f.makeServer();
  try {
    const releaseToken = f.harness.mint({ sub: 'rel-user', 'cognito:groups': ['release_approver'] });
    // At the clinical stage, a release approver has no authorized access.
    assert.equal((await app.app.inject({ method: 'GET', url: `/api/requests/${id}/review-context?category=RELEASE`, headers: bearer(releaseToken) })).statusCode, 404);
  } finally { await app.close(); }
});
