import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCognitoActor, isVerifiedCognitoClaims, cognitoCanAccessRequest } from '../src/cognito-auth.ts';
import type { WorkflowState } from '../src/workflow.ts';

const workflow = (over: Partial<WorkflowState>): WorkflowState => ({
  status: 'WAITING_FOR_SCREENING', version: 1, ownerId: 'owner-1', brief: {} as never,
  contributorIds: [], screening: null, confirmation: null, routing: null, logic: null, checks: null,
  clinicalApproval: null, compilationId: null, compilerId: null, artifact: null, verificationId: null,
  verification: null, releaseApproval: null, stoppedAt: null, processedEvents: [], ...over,
});
const getWorkflowReturning = (state: WorkflowState | null) => async () => state;

test('maps each R7 Cognito group to its workflow role', () => {
  assert.deepEqual(resolveCognitoActor({ sub: 'u1', groups: ['po'] }), { id: 'u1', roles: ['PO'] });
  assert.deepEqual(resolveCognitoActor({ sub: 'u2', groups: ['service_designer'] }), { id: 'u2', roles: ['SERVICE_DESIGNER'] });
  assert.deepEqual(resolveCognitoActor({ sub: 'u3', groups: ['clinician'] }), { id: 'u3', roles: ['CLINICIAN'] });
  assert.deepEqual(resolveCognitoActor({ sub: 'u4', groups: ['release_approver'] }), { id: 'u4', roles: ['RELEASE_APPROVER'] });
  assert.deepEqual(resolveCognitoActor({ sub: 'u5', groups: ['developer'] }), { id: 'u5', roles: ['ORCHESTRATOR'] });
});

test('combines multiple recognized groups into multiple roles', () => {
  const actor = resolveCognitoActor({ sub: 'u6', groups: ['po', 'clinician'] });
  assert.equal(actor?.id, 'u6');
  assert.deepEqual([...(actor?.roles ?? [])].sort(), ['CLINICIAN', 'PO']);
});

test('returns null when no recognized group is present (never defaults a role)', () => {
  assert.equal(resolveCognitoActor({ sub: 'u7', groups: ['unknown-group'] }), null);
  assert.equal(resolveCognitoActor({ sub: 'u8', groups: [] }), null);
});

test('rejects anything that is not verified claims', () => {
  assert.equal(resolveCognitoActor(undefined), null);
  assert.equal(resolveCognitoActor('po'), null);
  assert.equal(resolveCognitoActor({ groups: ['po'] }), null);
  assert.equal(resolveCognitoActor({ sub: '', groups: ['po'] }), null);
  assert.equal(resolveCognitoActor({ sub: 'u', groups: [1, 2] }), null);
  assert.equal(isVerifiedCognitoClaims({ sub: 'u', groups: ['po'] }), true);
  assert.equal(isVerifiedCognitoClaims({ sub: 'u' }), false);
});

test('request access is authoritative: the owner may access their request', async () => {
  const state = workflow({ ownerId: 'u-po', status: 'WAITING_FOR_SCREENING' });
  assert.equal(await cognitoCanAccessRequest(getWorkflowReturning(state), { sub: 'u-po', groups: ['po'] }, 'req-1'), true);
});

test('request access: a non-owner PO cannot access someone else\'s request', async () => {
  const state = workflow({ ownerId: 'someone-else', status: 'WAITING_FOR_SCREENING' });
  assert.equal(await cognitoCanAccessRequest(getWorkflowReturning(state), { sub: 'u-po', groups: ['po'] }, 'req-1'), false);
});

test('request access: a clinician may access a request pending clinical approval', async () => {
  const pending = workflow({ ownerId: 'someone-else', status: 'WAITING_FOR_CLINICAL_APPROVAL' });
  assert.equal(await cognitoCanAccessRequest(getWorkflowReturning(pending), { sub: 'u-clin', groups: ['clinician'] }, 'req-1'), true);
  // ...but NOT one that is not yet at the clinician's queue stage.
  const notYet = workflow({ ownerId: 'someone-else', status: 'WAITING_FOR_SCREENING' });
  assert.equal(await cognitoCanAccessRequest(getWorkflowReturning(notYet), { sub: 'u-clin', groups: ['clinician'] }, 'req-1'), false);
});

test('request access: release approver only at the release stage', async () => {
  const release = workflow({ ownerId: 'x', status: 'WAITING_FOR_RELEASE_APPROVAL' });
  assert.equal(await cognitoCanAccessRequest(getWorkflowReturning(release), { sub: 'u-rel', groups: ['release_approver'] }, 'req-1'), true);
  const clinical = workflow({ ownerId: 'x', status: 'WAITING_FOR_CLINICAL_APPROVAL' });
  assert.equal(await cognitoCanAccessRequest(getWorkflowReturning(clinical), { sub: 'u-rel', groups: ['release_approver'] }, 'req-1'), false);
});

test('request access fails closed: unknown request, unverified context, or store error', async () => {
  assert.equal(await cognitoCanAccessRequest(getWorkflowReturning(null), { sub: 'u', groups: ['po'] }, 'req-1'), false);
  assert.equal(await cognitoCanAccessRequest(getWorkflowReturning(workflow({})), 'po', 'req-1'), false);
  assert.equal(await cognitoCanAccessRequest(getWorkflowReturning(workflow({})), { sub: 'u', groups: ['nope'] }, 'req-1'), false);
  const throwing = async () => { throw new Error('store down'); };
  assert.equal(await cognitoCanAccessRequest(throwing, { sub: 'u', groups: ['po'] }, 'req-1'), false);
});
