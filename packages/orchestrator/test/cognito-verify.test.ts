/**
 * Real Cognito JWT verification tests. Tokens are RS256-signed with a locally
 * generated key; aws-jwt-verify checks signatures against the matching JWKS
 * fully offline. Covers signature, client id, token_use, expiry, issuer and
 * role-spoofing resistance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCognitoAuthentication, resolveCognitoActor } from '../src/cognito-auth.ts';
import type { WorkflowState } from '../src/workflow.ts';
import { createTokenHarness, TEST_USER_POOL_ID, TEST_CLIENT_ID, TEST_ISS } from './helpers/cognito-test-tokens.ts';

const req = (authorization?: string) => ({ headers: authorization ? { authorization } : {}, raw: {} as never });
const anyWorkflow = async (): Promise<WorkflowState | null> => null;

function authWith(harness: ReturnType<typeof createTokenHarness>, over: { clientId?: string; tokenUse?: 'access' | 'id' } = {}) {
  return createCognitoAuthentication({
    userPoolId: TEST_USER_POOL_ID, clientId: over.clientId ?? TEST_CLIENT_ID, tokenUse: over.tokenUse ?? 'access',
    getWorkflow: anyWorkflow, verifier: harness.makeVerifier(over),
  });
}

test('accepts a valid access token and exposes only verified claims', async () => {
  const h = createTokenHarness();
  const auth = authWith(h);
  const principal = await auth.authenticate(req(`Bearer ${h.mint({ sub: 'u-clin', 'cognito:groups': ['clinician'] })}`));
  assert.ok(principal, 'should authenticate');
  const actor = resolveCognitoActor(principal!.context);
  assert.deepEqual(actor, { id: 'u-clin', roles: ['CLINICIAN'] });
});

test('rejects a token with no Authorization / non-Bearer header', async () => {
  const auth = authWith(createTokenHarness());
  assert.equal(await auth.authenticate(req()), null);
  assert.equal(await auth.authenticate(req('Basic abc')), null);
  assert.equal(await auth.authenticate(req('Bearer ')), null);
});

test('rejects a tampered signature (signed with a different key)', async () => {
  const h = createTokenHarness();
  const auth = authWith(h);
  const forged = h.mint({ 'cognito:groups': ['release_approver'] }, { useWrongKey: true });
  assert.equal(await auth.authenticate(req(`Bearer ${forged}`)), null);
});

test('rejects a token minted for a different client id', async () => {
  const h = createTokenHarness();
  const auth = authWith(h); // verifier expects TEST_CLIENT_ID
  const wrong = h.mint({ client_id: 'some-other-client' });
  assert.equal(await auth.authenticate(req(`Bearer ${wrong}`)), null);
});

test('rejects an id token when access tokens are expected', async () => {
  const h = createTokenHarness();
  const auth = authWith(h); // tokenUse: 'access'
  const idToken = h.mint({ token_use: 'id' });
  assert.equal(await auth.authenticate(req(`Bearer ${idToken}`)), null);
});

test('rejects an expired token', async () => {
  const h = createTokenHarness();
  const auth = authWith(h);
  const past = Math.floor(Date.now() / 1000) - 10;
  const expired = h.mint({ iat: past - 3600, exp: past });
  assert.equal(await auth.authenticate(req(`Bearer ${expired}`)), null);
});

test('rejects a token from a different issuer / user pool', async () => {
  const h = createTokenHarness();
  const auth = authWith(h);
  const wrongIss = h.mint({ iss: 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_Other' });
  assert.equal(await auth.authenticate(req(`Bearer ${wrongIss}`)), null);
});

test('ROLE SPOOFING: only verified cognito:groups determine roles', async () => {
  const h = createTokenHarness();
  const auth = authWith(h);
  // A token whose VERIFIED groups are just 'po' cannot act as a clinician,
  // regardless of any other (unverified) fields a client might attach.
  const token = h.mint({ sub: 'u-po', 'cognito:groups': ['po'], 'custom:role': 'clinician', roles: ['CLINICIAN'] });
  const principal = await auth.authenticate(req(`Bearer ${token}`));
  assert.ok(principal);
  assert.deepEqual(resolveCognitoActor(principal!.context), { id: 'u-po', roles: ['PO'] });
});

test('a verified token with no recognized group yields a principal but no actor role', async () => {
  const h = createTokenHarness();
  const auth = authWith(h);
  const token = h.mint({ sub: 'u-x', 'cognito:groups': ['some-unmapped-group'] });
  const principal = await auth.authenticate(req(`Bearer ${token}`));
  assert.ok(principal); // token is validly signed...
  assert.equal(resolveCognitoActor(principal!.context), null); // ...but maps to no role
});

test('issuer string matches the R7 user-pool convention', () => {
  assert.equal(TEST_ISS, `https://cognito-idp.us-west-2.amazonaws.com/${TEST_USER_POOL_ID}`);
});
