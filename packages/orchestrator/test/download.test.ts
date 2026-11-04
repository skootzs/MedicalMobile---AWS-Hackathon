/**
 * Download/artifact route fail-closed behavior (in-memory, no DynamoDB).
 * Unapproved or non-existent artifacts are never exposed as released downloads.
 * The happy path (RELEASE_APPROVED -> 200 with the object reference) is covered
 * end to end in verification.integration.test.ts against DynamoDB Local.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalApi } from '../src/server.ts';
import { ApprovalService } from '../src/approvals.ts';
import { store, resolveActor, at } from './helpers/approval-fixtures.ts';
import { testAuthentication, sessionHeaders } from './helpers/api-fixtures.ts';
import type { WorkflowStatus } from '../src/workflow.ts';

function api(db: ReturnType<typeof store>) {
  return createLocalApi({ store: db, approvals: new ApprovalService({ store: db, resolveActor }), authentication: testAuthentication });
}

test('artifact endpoint returns 404 for a request that is not release-approved', async () => {
  const db = store();
  const nonReleased: WorkflowStatus[] = ['WAITING_FOR_CLINICAL_APPROVAL', 'CLINICALLY_APPROVED', 'WAITING_FOR_VERIFICATION', 'WAITING_FOR_RELEASE_APPROVAL'];
  for (const status of nonReleased) {
    await at(db, status);
    const a = api(db);
    try {
      const r = await a.inject({ method: 'GET', url: '/api/requests/fictional-001/artifact', headers: sessionHeaders('po') });
      assert.equal(r.statusCode, 404, `${status}: ${r.body}`);
    } finally { await a.close(); }
  }
});

test('artifact endpoint returns 404 for an unknown request', async () => {
  const db = store();
  const a = api(db);
  try {
    const r = await a.inject({ method: 'GET', url: '/api/requests/fictional-unknown/artifact', headers: sessionHeaders('po') });
    assert.equal(r.statusCode, 404, r.body);
  } finally { await a.close(); }
});

test('artifact endpoint requires authentication', async () => {
  const db = store();
  await at(db, 'WAITING_FOR_RELEASE_APPROVAL');
  const a = api(db);
  try {
    const r = await a.inject({ method: 'GET', url: '/api/requests/fictional-001/artifact' });
    assert.equal(r.statusCode, 401, r.body);
  } finally { await a.close(); }
});

// The RELEASE_APPROVED -> 200 happy path requires a real accepted compilation
// result (object URIs/manifest), so it is covered end to end against DynamoDB
// Local in verification.integration.test.ts, not with the in-memory fixtures
// whose legacy COMPILED path stores no compilation result record.
