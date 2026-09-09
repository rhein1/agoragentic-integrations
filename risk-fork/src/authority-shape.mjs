import {
  securityKeyFingerprint,
  securityTextVariants,
} from './util.mjs';

const AUTHORITY_FAMILIES = Object.freeze([
  'authority', 'privilege', 'permission', 'capability', 'credential', 'secret',
  'token', 'bearer', 'handle', 'signer', 'wallet', 'session', 'keymaterial', 'privatekey',
  'signingkey', 'apikey',
]);

const SAFE_TOKEN_MEASUREMENT_FINGERPRINT =
  /^(?:(?:(?:max|min)(?:input|output)?|input|output|prompt|completion|cached|reasoning|total|estimated|consumed|remaining)(?:tokens|tokens?(?:count|limit|budget|usage|used|remaining))|tokens?(?:count|limit|budget|usage|used|remaining))$/;

export function normalizeAuthorityShapeKey(value) {
  return securityKeyFingerprint(value);
}

export function isForbiddenAuthorityShapeKey(value) {
  const fingerprint = normalizeAuthorityShapeKey(value);
  if (AUTHORITY_FAMILIES.some(
    (family) => family !== 'token' && fingerprint.includes(family),
  )) return true;
  return fingerprint.includes('token')
    && !SAFE_TOKEN_MEASUREMENT_FINGERPRINT.test(fingerprint);
}

export function containsObviousCapabilityLikeText(value) {
  const text = String(value);
  const variants = securityTextVariants(text);
  for (let index = 0; index < variants.length; index += 1) {
    const candidate = variants[index];
    if (/bearer\s+[a-z0-9._~+\/-]{8,}/i.test(candidate)) return true;
    for (const assignment of candidate.matchAll(/(?:^|[\s,;{])([^=:\n,;{}]{1,120})\s*[:=]/g)) {
      if (isForbiddenAuthorityShapeKey(assignment[1])) return true;
    }
  }
  const fingerprint = normalizeAuthorityShapeKey(text);
  const familyCount = AUTHORITY_FAMILIES
    .filter((family) => fingerprint.includes(family))
    .length;
  if (familyCount >= 2) return true;
  const states = ['grant', 'granted', 'active', 'enabled', 'issued', 'exposed', 'ref', 'value', 'material'];
  return AUTHORITY_FAMILIES.some((family) => fingerprint.includes(family)
    && states.some((state) => fingerprint.includes(state)));
}
