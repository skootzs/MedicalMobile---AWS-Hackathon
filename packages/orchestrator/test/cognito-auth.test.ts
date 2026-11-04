import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCognitoActor, isVerifiedCognitoClaims, pendingCognitoAuthentication, cognitoCanAccessRequest } from '../src/cognito-auth.ts';

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

test('pending AWS authentication fails closed: no token is ever trusted', async () => {
  assert.equal(await pendingCognitoAuthentication.authenticate({ headers: { authorization: 'Bearer anything' }, raw: {} as never }), null);
  assert.equal(await pendingCognitoAuthentication.canAccessRequest({ context: { sub: 'u', groups: ['po'] } }, 'demo-1'), false);
});

test('cognitoCanAccessRequest grants only verified, recognized identities', () => {
  assert.equal(cognitoCanAccessRequest({ context: { sub: 'u', groups: ['po'] } }, 'demo-1'), true);
  assert.equal(cognitoCanAccessRequest({ context: { sub: 'u', groups: ['nope'] } }, 'demo-1'), false);
  assert.equal(cognitoCanAccessRequest({ context: 'po' }, 'demo-1'), false);
});
