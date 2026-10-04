import { createPublicKey, createVerify } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { assertAllowedKeys, assertDataArray, assertPlainRecord } from './validation.mjs';

const ALGORITHMS = new Set(['RS256', 'ES256']);
const KEY_ID = /^[A-Za-z0-9._:@/-]{1,128}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const TENANT = /^[a-z0-9][a-z0-9_-]{2,62}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CLAIMS = new Set(['iss', 'aud', 'sub', 'key_id', 'key_hash', 'tenant_id', 'scope', 'scopes', 'iat', 'nbf', 'exp']);

function fail(message) { throw new TypeError(message); }

// Small bounded JSON parser. JSON.parse accepts duplicate object members;
// rejecting them here avoids ambiguous security claims/header interpretation.
function parseJson(text, label, maxDepth = 12) {
  let index = 0;
  const skip = () => { while (/[ \t\r\n]/.test(text[index] ?? '')) index += 1; };
  const string = () => {
    const start = index;
    if (text[index++] !== '"') fail(`${label} string is invalid`);
    let escaped = false;
    while (index < text.length) {
      const c = text[index++];
      if (c === '"' && !escaped) return JSON.parse(text.slice(start, index));
      if (c === '\\' && !escaped) escaped = true;
      else escaped = false;
      if (c < ' ' && !escaped) fail(`${label} string is invalid`);
    }
    fail(`${label} string is unterminated`);
  };
  const value = (depth) => {
    if (depth > maxDepth) fail(`${label} is too deep`);
    skip();
    const c = text[index];
    if (c === '"') return string();
    if (c === '{') {
      index += 1; skip(); const object = Object.create(null);
      if (text[index] === '}') { index += 1; return object; }
      let members = 0;
      while (true) {
        if (++members > 64) fail(`${label} has too many members`);
        skip(); const key = string();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype'
          || Object.hasOwn(object, key)) fail(`${label} has duplicate or dangerous members`);
        skip(); if (text[index++] !== ':') fail(`${label} object is invalid`);
        object[key] = value(depth + 1); skip();
        if (text[index] === '}') { index += 1; return object; }
        if (text[index++] !== ',') fail(`${label} object is invalid`);
      }
    }
    if (c === '[') {
      index += 1; skip(); const array = [];
      if (text[index] === ']') { index += 1; return array; }
      while (true) {
        if (array.length >= 64) fail(`${label} array is too large`);
        array.push(value(depth + 1)); skip();
        if (text[index] === ']') { index += 1; return array; }
        if (text[index++] !== ',') fail(`${label} array is invalid`);
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index));
    if (!match) fail(`${label} value is invalid`);
    index += match[0].length;
    return JSON.parse(match[0]);
  };
  const result = value(0); skip();
  if (index !== text.length) fail(`${label} has trailing data`);
  return result;
}

function decodePart(part, label, maxBytes) {
  if (!BASE64URL.test(part) || part.length % 4 === 1) fail(`${label} encoding is invalid`);
  const value = Buffer.from(part, 'base64url');
  if (value.toString('base64url') !== part) fail(`${label} encoding is noncanonical`);
  if (value.length > maxBytes) fail(`${label} is too large`);
  return value;
}

function normalizeJwks(jwks) {
  assertDataArray(jwks, 'static JWKS', { maxLength: 32 });
  if (jwks.length === 0) fail('static JWKS is invalid');
  const keys = new Map();
  for (const jwk of jwks) {
    assertPlainRecord(jwk, 'JWK');
    const { kid, kty, alg, use, key_ops } = jwk;
    if (typeof kid !== 'string' || !KEY_ID.test(kid) || keys.has(kid)) fail('JWK kid is invalid');
    const allowed = alg === 'RS256'
      ? new Set(['kty', 'n', 'e', 'kid', 'alg', 'use', 'key_ops'])
      : new Set(['kty', 'x', 'y', 'crv', 'kid', 'alg', 'use', 'key_ops']);
    if (Object.keys(jwk).some((name) => !allowed.has(name))) fail('JWK contains private or unknown members');
    if (key_ops !== undefined) assertDataArray(key_ops, 'JWK key_ops', { maxLength: 1 });
    if (!ALGORITHMS.has(alg) || (use !== undefined && use !== 'sig')
      || (key_ops !== undefined && (key_ops.length !== 1 || key_ops[0] !== 'verify'))) {
      fail('JWK usage is invalid');
    }
    if ((alg === 'RS256' && kty !== 'RSA') || (alg === 'ES256' && kty !== 'EC')) fail('JWK type is invalid');
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      const details = key.asymmetricKeyDetails ?? {};
      if (alg === 'RS256' && ((details.modulusLength ?? 0) < 2048 || details.modulusLength > 8192)) fail('RSA key size is invalid');
      if (alg === 'ES256' && details.namedCurve !== 'prime256v1') fail('EC curve is invalid');
      keys.set(kid, Object.freeze({ alg, key }));
    }
    catch { fail('JWK key material is invalid'); }
  }
  return keys;
}

function claimTime(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 4102444800) fail(`${name} is invalid`);
  return value;
}

export function createOfflineOAuthVerifier(options = {}) {
  assertPlainRecord(options, 'OAuth verifier options');
  assertAllowedKeys(options, ['issuer', 'audience', 'jwks', 'clock', 'clockSkewSeconds', 'maxTokenBytes', 'maxLifetimeSeconds'], 'OAuth verifier options');
  const { issuer, audience, jwks, clock = () => new Date(),
    clockSkewSeconds = 0, maxTokenBytes = 8192, maxLifetimeSeconds = 3600 } = options;
  if (typeof issuer !== 'string' || issuer.length < 1 || issuer.length > 512) fail('issuer is invalid');
  if (typeof audience !== 'string' || audience.length < 1 || audience.length > 512) fail('audience is invalid');
  if (typeof clock !== 'function' || !Number.isInteger(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 300
    || !Number.isInteger(maxTokenBytes) || maxTokenBytes < 256 || maxTokenBytes > 16384
    || !Number.isInteger(maxLifetimeSeconds) || maxLifetimeSeconds < 1 || maxLifetimeSeconds > 86400) fail('OAuth verifier bounds are invalid');
  const keys = normalizeJwks(jwks);
  const currentEpochSeconds = () => {
    try {
      const value = Date.parse(new Date(clock()).toISOString());
      if (!Number.isFinite(value)) throw new Error('clock');
      return Math.floor(value / 1000);
    } catch { fail('OAuth authentication failed'); }
  };
  return async function verify({ authorization, issuer: requestedIssuer, audience: requestedAudience } = {}) {
    if (requestedIssuer !== issuer || requestedAudience !== audience) fail('OAuth policy binding is invalid');
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) fail('Bearer authentication is required');
    const token = authorization.slice(7);
    if (Buffer.byteLength(token, 'utf8') > maxTokenBytes) fail('OAuth token is too large');
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !part || !BASE64URL.test(part))) fail('OAuth token format is invalid');
    const utf8 = (value, label) => new TextDecoder('utf-8', { fatal: true }).decode(value);
    const header = parseJson(utf8(decodePart(parts[0], 'OAuth header', 2048), 'OAuth header'), 'OAuth header');
    const claims = parseJson(utf8(decodePart(parts[1], 'OAuth claims', 8192), 'OAuth claims'), 'OAuth claims');
    const headerKeys = Object.keys(header);
    if (!header || Array.isArray(header) || typeof header !== 'object'
      || headerKeys.some((key) => !['alg', 'kid', 'typ'].includes(key)) || header.typ !== 'at+jwt' || !ALGORITHMS.has(header.alg)
      || typeof header.kid !== 'string' || !KEY_ID.test(header.kid)) fail('OAuth header is invalid');
    const selected = keys.get(header.kid);
    if (!selected || selected.alg !== header.alg) fail('OAuth signing key is unknown');
    const signature = decodePart(parts[2], 'OAuth signature', 1024);
    if (header.alg === 'ES256' && signature.length !== 64) fail('OAuth signature is invalid');
    const verifier = createVerify(header.alg === 'RS256' ? 'RSA-SHA256' : 'SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`); verifier.end();
    if (!verifier.verify({ key: selected.key, dsaEncoding: 'ieee-p1363' }, signature)) fail('OAuth signature is invalid');
    if (!claims || Array.isArray(claims) || typeof claims !== 'object') fail('OAuth claims are invalid');
    if (Object.keys(claims).some((name) => !CLAIMS.has(name))) fail('OAuth claims contain an unknown member');
    const now = currentEpochSeconds();
    const exp = claimTime(claims.exp, 'exp'); const nbf = claimTime(claims.nbf, 'nbf');
    const iat = claimTime(claims.iat, 'iat');
    if (exp <= nbf || iat > nbf || exp - iat > maxLifetimeSeconds || exp - nbf > maxLifetimeSeconds || iat > exp || now >= exp + clockSkewSeconds || now < nbf - clockSkewSeconds
      || iat > now + clockSkewSeconds || claims.iss !== issuer) fail('OAuth claims are invalid');
    const aud = claims.aud;
    if (!(typeof aud === 'string' && aud === audience) && !(Array.isArray(aud) && aud.length === 1 && aud[0] === audience)) fail('OAuth audience is invalid');
    if (claims.scope !== undefined && claims.scopes !== undefined) fail('OAuth scope claims are ambiguous');
    if (typeof claims.sub !== 'string' || !OPAQUE.test(claims.sub) || claims.sub !== claims.key_id
      || typeof claims.key_id !== 'string' || !OPAQUE.test(claims.key_id)
      || typeof claims.key_hash !== 'string' || !HASH.test(claims.key_hash)
      || typeof claims.tenant_id !== 'string' || !TENANT.test(claims.tenant_id)) fail('OAuth identity claims are invalid');
    const scopes = claims.scopes ?? (typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : null);
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 32 || new Set(scopes).size !== scopes.length
      || scopes.some((s) => typeof s !== 'string' || s.length < 1 || s.length > 128)) fail('OAuth scopes are invalid');
    return Object.freeze({ key_hash: claims.key_hash, key_id: claims.key_id, tenant_id: claims.tenant_id,
      issuer, audience, subject: claims.sub, scopes: Object.freeze([...new Set(scopes)]),
      not_before: new Date(nbf * 1000).toISOString(), expires_at: new Date(exp * 1000).toISOString() });
  };
}
