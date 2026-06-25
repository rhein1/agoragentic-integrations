#!/usr/bin/env node
import {
  createHash,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function hashRef(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value || {})).digest('hex')}`;
}

function withoutAuth(params) {
  const { auth: _auth, ...rest } = params || {};
  return rest;
}

function canonicalPostPinMessage({ method, relationshipId, remoteOrigin, nonce, timestamp, params }) {
  return [
    method,
    relationshipId,
    remoteOrigin,
    nonce,
    String(timestamp),
    hashRef(params || {}),
  ].join('\n');
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const method = 'federation/follow-referral';
const relationshipId = 'fed_partner_demo';
const remoteOrigin = 'https://partner.example';
const timestamp = 1710000000000;
const nonce = 'demo-nonce-001';

const wireParams = {
  relationship_id: relationshipId,
  remote_origin: remoteOrigin,
  referral_id: 'agx_fedref_demo',
  auth: {
    nonce,
    timestamp,
    signature_algorithm: 'ed25519',
    signature: '<filled after signing>',
  },
};

const actionParams = withoutAuth(wireParams);
const message = canonicalPostPinMessage({
  method,
  relationshipId,
  remoteOrigin,
  nonce,
  timestamp,
  params: actionParams,
});
const signature = sign(null, Buffer.from(message), privateKey).toString('base64');
const ok = verify(null, Buffer.from(message), publicKey, Buffer.from(signature, 'base64'));

const legacyMessage = canonicalPostPinMessage({
  method: 'referral.follow',
  relationshipId,
  remoteOrigin,
  nonce,
  timestamp,
  params: { referralId: wireParams.referral_id },
});
const legacyOk = verify(null, Buffer.from(legacyMessage), publicKey, Buffer.from(signature, 'base64'));

console.log(JSON.stringify({
  simulated_only: true,
  method,
  params_hash: hashRef(actionParams),
  canonical_message: message,
  signature_algorithm: 'ed25519',
  signature_base64: signature,
  verifies_with_advertised_method_and_snake_case_params: ok,
  verifies_with_legacy_method_and_camel_case_params: legacyOk,
  public_key_spki_der_base64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  note: 'This is a local signing simulation only; no live federation route was called.',
}, null, 2));

if (!ok || legacyOk) {
  process.exitCode = 1;
}
