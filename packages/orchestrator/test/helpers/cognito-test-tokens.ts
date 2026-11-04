/**
 * TEST ONLY. Mints real RS256-signed JWTs with a locally generated RSA key and
 * exposes the matching JWKS so aws-jwt-verify can verify signatures fully
 * offline (no network, no AWS). This exercises REAL signature/claim checking;
 * it is never imported by src/ and is not a production token issuer.
 */
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

export const TEST_USER_POOL_ID = 'us-west-2_Testpool';
export const TEST_CLIENT_ID = 'testclient';
export const TEST_ISS = `https://cognito-idp.us-west-2.amazonaws.com/${TEST_USER_POOL_ID}`;

const b64url = (buf: Uint8Array | string) => Buffer.from(buf).toString('base64url');

export interface TokenHarness {
  jwks: { keys: Record<string, string>[] };
  kid: string;
  /** Mint a signed token; override any claim or the signing key/kid for negative tests. */
  mint(overrides?: Record<string, unknown>, opts?: { kid?: string; useWrongKey?: boolean }): string;
  /** A CognitoJwtVerifier (access-token) with this harness's JWKS pre-cached. */
  makeVerifier(over?: { clientId?: string; tokenUse?: 'access' | 'id' }): ReturnType<typeof CognitoJwtVerifier.create>;
}

export function createTokenHarness(): TokenHarness {
  const main = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }); // an untrusted key for spoof tests
  const kid = 'test-kid-1';
  const jwk = main.publicKey.export({ format: 'jwk' }) as Record<string, string>;
  const jwks = { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] };

  function sign(payload: Record<string, unknown>, signKid: string, useWrongKey: boolean): string {
    const header = { alg: 'RS256', kid: signKid, typ: 'JWT' };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const key = useWrongKey ? other.privateKey : main.privateKey;
    const sig = createSign('RSA-SHA256').update(input).end().sign(key);
    return `${input}.${b64url(sig)}`;
  }

  function mint(overrides: Record<string, unknown> = {}, opts: { kid?: string; useWrongKey?: boolean } = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      sub: 'user-123', token_use: 'access', client_id: TEST_CLIENT_ID, iss: TEST_ISS,
      'cognito:groups': ['clinician'], scope: 'openid', auth_time: now,
      iat: now, exp: now + 3600, jti: randomUUID(), version: 2,
      ...overrides,
    };
    return sign(payload, opts.kid ?? kid, opts.useWrongKey ?? false);
  }

  function makeVerifier(over: { clientId?: string; tokenUse?: 'access' | 'id' } = {}) {
    const verifier = CognitoJwtVerifier.create({
      userPoolId: TEST_USER_POOL_ID,
      tokenUse: over.tokenUse ?? 'access',
      clientId: over.clientId ?? TEST_CLIENT_ID,
    });
    verifier.cacheJwks(jwks as unknown as Parameters<typeof verifier.cacheJwks>[0]);
    return verifier;
  }

  return { jwks, kid, mint, makeVerifier };
}
