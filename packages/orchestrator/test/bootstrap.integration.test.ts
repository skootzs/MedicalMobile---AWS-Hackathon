/**
 * End-to-end demonstration of the RUNNABLE Role 2 backend against DynamoDB Local
 * and the real durable local object store, driven through the production
 * bootstrap + Fastify HTTP surface with LOCAL/DEMO Cognito-shaped identities.
 *
 * Gated on R2_DYNAMODB_LOCAL_ENDPOINT (same convention as dynamodb.integration).
 *
 * TEST FIXTURES vs REAL INTEGRATIONS:
 *   - Request creation, clinical approval and the rejected self-approval go
 *     through the REAL HTTP routes, services, store, workflow and audit.
 *   - Screening (R3), logic drafting (R3) and checker results (R4) are driven by
 *     the existing TEST FIXTURES (FictionalChecker, next()). They are clearly
 *     labelled below and are NOT real R3/R4 integrations. No passing checker
 *     evidence, clinical decision, compiler result or R6 report is fabricated by
 *     the orchestrator itself; the fixtures only supply the inputs those gates
 *     consume, exactly as the pre-existing dynamodb.integration test does.
 */
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { bootstrap } from '../src/bootstrap.ts';
import type { OrchestratorConfig } from '../src/config.ts';
import { createDemoIdentity, demoHeaders } from '../src/demo-identity.ts';
import { resolveCognitoActor } from '../src/cognito-auth.ts';
import { DynamoOrchestratorStore } from '../src/storage/dynamodb.ts';
import { LocalObjectStore } from '../src/storage/local-objects.ts';
import { localClient, createLocalTable } from './helpers/dynamodb-local-fixtures.ts';
import { resolveReviewActor } from './helpers/review-fixtures.ts';
import { provisionalSnapshotValidator } from '../src/snapshots.ts';
import { r7Layout } from '../src/storage/r7-layout.ts';
import { next } from './helpers/approval-fixtures.ts';
import { CheckerResultService } from '../src/checkers.ts';
import { FictionalChecker } from './helpers/checker-fixtures.ts';
import type { Actor, WorkflowState, WorkflowStatus } from '../src/workflow.ts';

const endpoint = process.env.R2_DYNAMODB_LOCAL_ENDPOINT;
const integration = { skip: !endpoint };

/**
 * Resolver used ONLY by this demo's store: real demo Cognito claims first, then
 * the existing fixture string principals that stand in for R3/R4/backend workers.
 */
function demoResolveActor(principal: unknown): Actor | null {
  const cognito = resolveCognitoActor(principal);
  if (cognito) return cognito;
  return typeof principal === 'string' ? resolveReviewActor(principal) : null;
}

async function setup(t: TestContext) {
  const table = `r2-local-test-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), 'r2-demo-'));
  const client = localClient(endpoint!);
  await createLocalTable(client.client, table);
  const config: OrchestratorConfig = Object.freeze({
    mode: 'local', dynamoEndpoint: endpoint!, ddbTable: table, objectDirectory: directory, host: '127.0.0.1', port: 0,
  });
  // RequestService assigns IDs of the form `req-<sha256>`, so demo visibility
  // is scoped to that prefix (the demo users can see the requests they create).
  const identity = { ...createDemoIdentity({ requestPrefix: 'req-' }), resolveActor: demoResolveActor };
  const makeServer = () => bootstrap({ config, identity, documentClient: client.document, objects: new LocalObjectStore(directory) });
  // A direct store handle (same table/objects) for fixture-driven advance steps.
  const makeStore = () => new DynamoOrchestratorStore({
    client: client.document, tableName: table, objects: new LocalObjectStore(directory),
    layout: r7Layout, resolveActor: demoResolveActor, validateSnapshot: provisionalSnapshotValidator,
  });
  t.after(async () => { client.client.destroy(); await rm(directory, { recursive: true, force: true }); });
  return { config, makeServer, makeStore, table, client };
}

/** Advance the workflow using the EXISTING TEST FIXTURES (stand-ins for R3/R4). */
async function advanceWithFixtures(store: DynamoOrchestratorStore, id: string, target: WorkflowStatus): Promise<WorkflowState> {
  let s = (await store.getWorkflow(id))!;
  while (s.status !== target) {
    if (s.status === 'WAITING_FOR_LOGIC_CHECKS') {
      // FICTIONAL R4 checker fixture — not a real integration.
      const checker = new CheckerResultService({ store, resolveActor: demoResolveActor, canAccessRequest: () => true,
        checker: { checkerActorId: 'fictional-checker', checkerId: 'fictional-r4-checker', checkerVersion: 'fixture-v1' } });
      const c = { requestId: id, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash, ...s.logic!, expectedVersion: s.version, eventId: `fixture-authorize-${s.version}` };
      const a = await checker.authorize(c, 'backend');
      assert.equal(a.status, 'AUTHORIZED', a.reason);
      const snapshot = await store.getSnapshot({ kind: 'LOGIC_MODEL', requestId: id, revision: s.logic!.logicRevision, requestPreview: { requestId: id, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash } });
      if (snapshot?.kind !== 'LOGIC_MODEL') throw new Error('fixture');
      const report = await new FictionalChecker().check(a.invocation!, snapshot);
      const r = await checker.ingest({ ...c, eventId: `fixture-check-${s.version}`, invocationId: a.invocation!.invocationId, report }, 'checker');
      assert.equal(r.status, 'ACCEPTED', r.reason);
    } else {
      const step = next(s);
      // The PO_DECISION step must come from the request's OWNER. The request was
      // created over HTTP as the demo PO (sub 'demo-po'), so drive the owner-bound
      // PO step with the demo PO's verified claims instead of the fixture's
      // 'fictional-po'. Worker steps (ai/backend) are not owner-bound.
      const who = step.who === 'po' ? { sub: 'demo-po', groups: ['po'] } : step.who;
      const r = await store.apply(step.cmd, who);
      assert.equal(r.outcome, 'ACCEPTED', r.reason);
    }
    s = (await store.getWorkflow(id))!;
  }
  return s;
}

test('DEMO: create request over HTTP as the demo PO', integration, async (t) => {
  const f = await setup(t);
  const server = f.makeServer();
  try {
    const res = await server.app.inject({ method: 'POST', url: '/api/requests', headers: demoHeaders('demo-po'),
      payload: { eventId: 'demo-create-1', expectedVersion: 0, content: {
        title: 'Fictional child cough triage', objective: 'Demonstrate the R2 workflow.',
        targetPopulation: 'Fictional training households',
        requirements: [{ condition: 'Child has cough', action: 'Record respiratory rate' }] } } });
    assert.equal(res.statusCode, 201, res.body);
    const id = res.json().requestId as string;
    assert.ok(id.startsWith('req-'), id);
    // Created request is visible to the demo PO over HTTP.
    const got = await server.app.inject({ method: 'GET', url: `/api/requests/${id}`, headers: demoHeaders('demo-po') });
    assert.equal(got.statusCode, 200, got.body);
    assert.equal(got.json().status, 'WAITING_FOR_SCREENING');
  } finally { await server.close(); }
});

test('DEMO: advance to pending clinical approval, then recover after a full restart', integration, async (t) => {
  const f = await setup(t);
  const server = f.makeServer();
  let id: string;
  try {
    const res = await server.app.inject({ method: 'POST', url: '/api/requests', headers: demoHeaders('demo-po'),
      payload: { eventId: 'demo-create-2', expectedVersion: 0, content: {
        title: 'Fictional pending-approval case', objective: 'Reach WAITING_FOR_CLINICAL_APPROVAL.',
        targetPopulation: 'Fictional households', requirements: [{ condition: 'Symptom present', action: 'Escalate' }] } } });
    assert.equal(res.statusCode, 201, res.body);
    id = res.json().requestId as string;
  } finally { await server.close(); }

  // Advance using fixtures (R3/R4 stand-ins) through a direct store handle.
  const pending = await advanceWithFixtures(f.makeStore(), id, 'WAITING_FOR_CLINICAL_APPROVAL');
  assert.equal(pending.status, 'WAITING_FOR_CLINICAL_APPROVAL');

  // RESTART: a brand-new bootstrap (new store, new object provider, new app)
  // recovers the pending approval and its clinical review context over HTTP.
  const recovered = f.makeServer();
  try {
    // The clinician recovers the pending item through the reviewer queue...
    const queue = await recovered.app.inject({ method: 'GET', url: '/api/reviews/queue?category=CLINICAL', headers: demoHeaders('demo-clinician') });
    assert.equal(queue.statusCode, 200, queue.body);
    assert.ok((queue.json().items as { requestId: string }[]).some(i => i.requestId === id), queue.body);
    // ...and the clinical review-context for that exact request.
    const context = await recovered.app.inject({ method: 'GET', url: `/api/requests/${id}/review-context?category=CLINICAL`, headers: demoHeaders('demo-clinician') });
    assert.equal(context.statusCode, 200, context.body);
    assert.equal(context.json().status, 'WAITING_FOR_CLINICAL_APPROVAL');
    // The owning PO still sees it through the owner-only intake view.
    const owner = await recovered.app.inject({ method: 'GET', url: `/api/requests/${id}`, headers: demoHeaders('demo-po') });
    assert.equal(owner.statusCode, 200, owner.body);
    assert.equal(owner.json().status, 'WAITING_FOR_CLINICAL_APPROVAL');
  } finally { await recovered.close(); }
});

test('DEMO: valid clinical approval succeeds; self-approval by the author is rejected', integration, async (t) => {
  const f = await setup(t);
  const server = f.makeServer();
  let id: string;
  try {
    const res = await server.app.inject({ method: 'POST', url: '/api/requests', headers: demoHeaders('demo-po'),
      payload: { eventId: 'demo-create-3', expectedVersion: 0, content: {
        title: 'Fictional approval-gate case', objective: 'Demonstrate the clinical approval gate.',
        targetPopulation: 'Fictional households', requirements: [{ condition: 'Finding present', action: 'Record outcome' }] } } });
    assert.equal(res.statusCode, 201, res.body);
    id = res.json().requestId as string;
  } finally { await server.close(); }

  const pending = await advanceWithFixtures(f.makeStore(), id, 'WAITING_FOR_CLINICAL_APPROVAL');
  const approvalBody = {
    eventId: 'demo-clinical-decision', expectedVersion: pending.version,
    requestRevision: pending.brief.revision, requestSnapshotHash: pending.brief.snapshotHash,
    logicRevision: pending.logic!.logicRevision, logicHash: pending.logic!.logicHash,
    checkerReportId: pending.checks!.reportId, decision: 'APPROVE' as const,
  };

  const app = f.makeServer();
  try {
    // REJECTED: the PO authored this request; the SAME person as a clinician
    // (demo-po-clinician shares sub 'demo-po') cannot clinically approve it.
    const self = await app.app.inject({ method: 'POST', url: `/api/requests/${id}/clinical-decisions`,
      headers: demoHeaders('demo-po-clinician'), payload: { ...approvalBody, eventId: 'demo-self-approval' } });
    assert.equal(self.statusCode, 403, self.body);
    assert.equal((await f.makeStore().getWorkflow(id))?.status, 'WAITING_FOR_CLINICAL_APPROVAL');

    // UNAUTHENTICATED attempt is blocked.
    const anon = await app.app.inject({ method: 'POST', url: `/api/requests/${id}/clinical-decisions`, payload: approvalBody });
    assert.equal(anon.statusCode, 401, anon.body);

    // VALID: an independent clinician approves.
    const ok = await app.app.inject({ method: 'POST', url: `/api/requests/${id}/clinical-decisions`,
      headers: demoHeaders('demo-clinician'), payload: approvalBody });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((await f.makeStore().getWorkflow(id))?.status, 'CLINICALLY_APPROVED');

    // Durable projection records the approval.
    const row = await f.client.document.send(new GetCommand({ TableName: f.table, Key: { pk: `REQ#${id}`, sk: 'APPROVAL#demo-clinical-decision' }, ConsistentRead: true }));
    assert.equal(row.Item?.status, 'APPROVED');
    assert.equal(row.Item?.decision, 'approved');
  } finally { await app.close(); }
});
