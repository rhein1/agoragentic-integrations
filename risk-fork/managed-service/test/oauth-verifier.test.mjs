import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { createOfflineOAuthVerifier } from '../src/oauth-verifier.mjs';
import { createTrustedOAuthAuthenticator, hashManagedApiKey } from '../src/auth.mjs';

const NOW = 1_759_000_000;
const issuer = 'https://issuer.example.test';
const audience = 'risk-fork';
// Use generated keys while keeping all verification offline and deterministic.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'rsa-1', alg: 'RS256', use: 'sig' };
const { privateKey: ecPrivateKey, publicKey: ecPublicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ecJwk = { ...ecPublicKey.export({ format: 'jwk' }), kid: 'ec-1', alg: 'ES256', use: 'sig' };
function token(overrides = {}, key = privateKey, alg = 'RS256', headerOverrides = {}, kid = alg === 'ES256' ? 'ec-1' : 'rsa-1') {
  const h = Buffer.from(JSON.stringify({ alg, kid, typ: 'at+jwt', ...headerOverrides })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, sub: 'key_1', key_id: 'key_1', key_hash: `sha256:${'a'.repeat(64)}`, tenant_id: 'tenant_1', scopes: ['invocations:write'], iat: NOW, nbf: NOW, exp: NOW + 300, ...overrides })).toString('base64url');
  const s = createSign(alg === 'ES256' ? 'SHA256' : 'RSA-SHA256'); s.update(`${h}.${p}`); s.end();
  return `${h}.${p}.${s.sign(alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key).toString('base64url')}`;
}
function verifier(jwks = [jwk]) { return createOfflineOAuthVerifier({ issuer, audience, jwks, clock: () => new Date(NOW * 1000) }); }

test('verifies a signed static-JWKS token and returns auth.mjs identity shape', async () => {
  const identity = await verifier()({ authorization: `Bearer ${token()}`, issuer, audience });
  assert.equal(identity.subject, 'key_1'); assert.equal(identity.tenant_id, 'tenant_1');
  assert.deepEqual(identity.scopes, ['invocations:write']);
});

test('verifies a P-256 ES256 access token', async () => {
  const identity = await verifier([ecJwk])({ authorization: `Bearer ${token({}, ecPrivateKey, 'ES256')}`, issuer, audience });
  assert.equal(identity.key_id, 'key_1');
});

test('rejects malformed, duplicate, unsupported, replay-window, and identity-substitution tokens', async () => {
  const verify = verifier();
  for (const value of [
    'Bearer x', `Bearer ${token({ exp: NOW - 100 })}`, `Bearer ${token({ iss: 'other' })}`,
    `Bearer ${token({ aud: ['risk-fork', 'other'] })}`, `Bearer ${token({ sub: 'other' })}`,
  ]) await assert.rejects(verify({ authorization: value, issuer, audience }));
  const parts = token().split('.');
  const duplicate = Buffer.from('{"iss":"' + issuer + '","iss":"other"}').toString('base64url');
  await assert.rejects(verify({ authorization: `Bearer ${parts[0]}.${duplicate}.${parts[2]}`, issuer, audience }));
});

test('is offline-only and rejects policy substitution, unknown key, and algorithm confusion', async () => {
  const verify = verifier();
  await assert.rejects(verify({ authorization: `Bearer ${token()}`, issuer: 'other', audience }));
  const validParts = token().split('.');
  const unknown = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'rsa-2', typ: 'at+jwt' })).toString('base64url')}.${validParts[1]}.${validParts[2]}`;
  await assert.rejects(verify({ authorization: `Bearer ${unknown}`, issuer, audience }));
  const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'rsa-1' })).toString('base64url')}.${token().split('.')[1]}.x`;
  await assert.rejects(verify({ authorization: `Bearer ${none}`, issuer, audience }));
});

test('rejects header extensions, scope ambiguity, old iat, and exact expiry', async () => {
  const verify = verifier();
  await assert.rejects(verify({ authorization: `Bearer ${token({}, privateKey, 'RS256', { extra: true })}`, issuer, audience }));
  await assert.rejects(verify({ authorization: `Bearer ${token({ scope: 'one', scopes: ['one'] })}`, issuer, audience }));
  await assert.rejects(verify({ authorization: `Bearer ${token({ iat: NOW - 5000 })}`, issuer, audience }));
  await assert.rejects(verifier()({ authorization: `Bearer ${token({ iat: NOW - 100, nbf: NOW - 100, exp: NOW })}`, issuer, audience }));
});

test('rejects dangerous duplicate members, noncanonical base64url, and invalid UTF-8', async () => {
  const verify = verifier(); const parts = token().split('.');
  const duplicate = Buffer.from('{"iss":"' + issuer + '","__proto__":{},"iss":"other"}').toString('base64url');
  await assert.rejects(verify({ authorization: `Bearer ${parts[0]}.${duplicate}.${parts[2]}`, issuer, audience }));
  await assert.rejects(verify({ authorization: `Bearer ${parts[0]}=.${parts[1]}.${parts[2]}`, issuer, audience }));
  const trailingBits = `${parts[0].slice(0, -1)}B`;
  await assert.rejects(verify({ authorization: `Bearer ${trailingBits}.${parts[1]}.${parts[2]}`, issuer, audience }));
  const invalidUtf8 = Buffer.from([0xff, 0xfe]).toString('base64url');
  await assert.rejects(verify({ authorization: `Bearer ${invalidUtf8}.${parts[1]}.${parts[2]}`, issuer, audience }));
});

test('rejects weak RSA and non-P256 EC keys at construction', () => {
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' });
  assert.throws(() => createOfflineOAuthVerifier({ issuer, audience, jwks: [{ ...weak, kid: 'weak', alg: 'RS256' }] }), /weak|material/);
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ format: 'jwk' });
  assert.throws(() => createOfflineOAuthVerifier({ issuer, audience, jwks: [{ ...ec, kid: 'ec', alg: 'ES256' }] }), /curve|material/);
  assert.throws(() => createOfflineOAuthVerifier({ issuer, audience, jwks: [{ ...jwk, kid: 'dup' }, { ...jwk, kid: 'dup' }] }), /kid/);
  assert.throws(() => createOfflineOAuthVerifier({ issuer, audience, jwks: [{ ...jwk, d: 'private' }] }), /private|material/);
  assert.throws(() => createOfflineOAuthVerifier({ issuer, audience, jwks: [{ ...jwk, alg: 'ES256' }] }), /type|material|unknown/);
});

test('fits the createTrustedOAuthAuthenticator verify callback contract', async () => {
  const keyHash = hashManagedApiKey('x'.repeat(32));
  const store = { async resolveCredential(hash) { return hash === keyHash ? {
    schema: 'agoragentic.risk-fork.managed-api-key.v1', key_id: 'key_1', tenant_id: 'tenant_1',
    key_hash: keyHash, scopes: ['invocations:write'], not_before: new Date((NOW - 100) * 1000).toISOString(),
    expires_at: new Date((NOW + 300) * 1000).toISOString(), revoked_at: null,
  } : null; } };
  const oauth = createOfflineOAuthVerifier({ issuer, audience, jwks: [jwk], clock: () => new Date(NOW * 1000) });
  const auth = createTrustedOAuthAuthenticator({ store, issuer, audience, clock: () => new Date(NOW * 1000), verify: oauth });
  const principal = await auth.authenticate(`Bearer ${token({ key_hash: keyHash })}`, 'invocations:write');
  assert.equal(principal.tenant_id, 'tenant_1');
});

test('invalid verifier clock fails with a constant authentication error', async () => {
  const verify = createOfflineOAuthVerifier({ issuer, audience, jwks: [jwk], clock: () => 'not-a-date' });
  await assert.rejects(verify({ authorization: `Bearer ${token()}`, issuer, audience }), { message: 'OAuth authentication failed' });
});
