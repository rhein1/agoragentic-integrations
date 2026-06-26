#!/usr/bin/env node
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

export function hashRef(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value ?? {})).digest('hex')}`;
}

export function paramsWithoutAuth(params = {}) {
  const { auth: _auth, ...rest } = params || {};
  return rest;
}

export function canonicalPostPinMessage({
  method,
  relationshipId,
  remoteOrigin,
  nonce,
  timestamp,
  params,
}) {
  return [
    method,
    relationshipId,
    remoteOrigin,
    nonce,
    String(timestamp),
    hashRef(params || {}),
  ].join('\n');
}

export function challengeResponseHashRef({ challenge, body }) {
  return hashRef({ challenge, body: body && typeof body === 'object' ? body : {} });
}

export function createPilotAgentCard({
  name,
  agentId,
  agentUrl,
  keyId,
  publicKeyDerBase64,
}) {
  return {
    schema: 'agoragentic.agent-card.v1',
    name,
    agent_id: agentId,
    url: agentUrl,
    description: 'Partner-controlled A2A federation pilot card for Agoragentic Interchange. Protocol pilot only; not an external-demand claim.',
    extensions: {
      'agoragentic:federation': {
        schema: 'agoragentic.agent-federation.v1',
        key_id: keyId,
        public_key_der_base64: publicKeyDerBase64,
        capability_exchange: true,
        federation_consent: true,
        trust_model: 'key_control_tofu_not_identity',
      },
    },
  };
}

export function generateDemoKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey,
    privateKey,
    publicKeyDerBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

export function signMessageBase64(privateKey, message) {
  return sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');
}

export function verifyMessageBase64(publicKey, message, signatureBase64) {
  return verify(null, Buffer.from(message, 'utf8'), publicKey, Buffer.from(signatureBase64, 'base64'));
}

function loadVectors() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const vectorPath = path.resolve(here, '../../conformance/vectors.json');
  return JSON.parse(readFileSync(vectorPath, 'utf8'));
}

export function runSelfTest() {
  const vectors = loadVectors();
  const failures = [];

  for (const vector of vectors.post_pin_signing || []) {
    const paramsHash = hashRef(vector.params_without_auth);
    const message = canonicalPostPinMessage({
      method: vector.method,
      relationshipId: vector.relationship_id,
      remoteOrigin: vector.remote_origin,
      nonce: vector.nonce,
      timestamp: vector.timestamp,
      params: vector.params_without_auth,
    });
    const messageHex = Buffer.from(message, 'utf8').toString('hex');
    if (paramsHash !== vector.expected_params_hash) failures.push(`${vector.id}: params hash mismatch`);
    if (message !== vector.expected_canonical_message) failures.push(`${vector.id}: canonical message mismatch`);
    if (messageHex !== vector.expected_canonical_message_utf8_hex) failures.push(`${vector.id}: UTF-8 hex mismatch`);
  }

  for (const vector of vectors.challenge_response || []) {
    const challengeHash = challengeResponseHashRef({ challenge: vector.challenge, body: vector.body });
    if (challengeHash !== vector.expected_challenge_hash) failures.push(`${vector.id}: challenge hash mismatch`);
  }

  const demo = generateDemoKeyPair();
  const sample = vectors.post_pin_signing?.[0];
  if (sample) {
    const message = canonicalPostPinMessage({
      method: sample.method,
      relationshipId: sample.relationship_id,
      remoteOrigin: sample.remote_origin,
      nonce: sample.nonce,
      timestamp: sample.timestamp,
      params: sample.params_without_auth,
    });
    const signature = signMessageBase64(demo.privateKey, message);
    if (!verifyMessageBase64(demo.publicKey, message, signature)) failures.push('demo ed25519 signature failed');
  }

  return {
    ok: failures.length === 0,
    failures,
    vectors_checked: {
      post_pin_signing: vectors.post_pin_signing?.length || 0,
      challenge_response: vectors.challenge_response?.length || 0,
    },
    note: 'No network calls, payments, trust mutations, or registry submissions were made.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runSelfTest();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
