import {
  isBoundedTokenMeasurementValue,
  isTokenMeasurementKey,
  securityKeyFingerprint,
  securityKeyFingerprints,
  securityTextVariants,
} from './util.mjs';

const AUTHORITY_FAMILIES = Object.freeze([
  'authority', 'privilege', 'permission', 'capability', 'credential', 'secret',
  'token', 'bearer', 'handle', 'signer', 'wallet', 'session', 'keymaterial', 'privatekey',
  'signingkey', 'apikey', 'password', 'passphrase',
]);

export function normalizeAuthorityShapeKey(value) {
  return securityKeyFingerprint(value);
}

export function isForbiddenAuthorityShapeKey(value) {
  const fingerprints = securityKeyFingerprints(value);
  for (let index = 0; index < fingerprints.length; index += 1) {
    const fingerprint = fingerprints[index];
    if (AUTHORITY_FAMILIES.some(
      (family) => family !== 'token' && fingerprint.includes(family),
    )) return true;
    if (fingerprint.includes('token') && !isTokenMeasurementKey(value)) return true;
  }
  return false;
}

function isSafeTokenMeasurementKey(value) {
  return isTokenMeasurementKey(value);
}

export function isTokenMeasurementShapeKey(value) {
  return isSafeTokenMeasurementKey(value);
}

export function isForbiddenAuthorityShapeEntry(key, value) {
  if (isForbiddenAuthorityShapeKey(key)) return true;
  return isSafeTokenMeasurementKey(key) && !isBoundedTokenMeasurementValue(value);
}

export function containsObviousCapabilityLikeText(value) {
  const text = String(value);
  const variants = securityTextVariants(text);
  for (let index = 0; index < variants.length; index += 1) {
    const candidate = variants[index];
    if (/bearer\s+[a-z0-9._~+\/-]{8,}/i.test(candidate)) return true;
    // Finds `key:` / `key =` style assignments without nesting quantified
    // character classes (which risks polynomial backtracking). The key pattern
    // uses a single bounded quantifier; the separator check is a separate
    // anchored test so neither regex has adjacent overlapping quantifiers.
    for (const assignment of candidate.matchAll(/(?:^|[\s,;{])([^=:\n,;{}]{1,120})/g)) {
      const rest = candidate.slice(assignment.index + assignment[0].length);
      if (!/^\s*[:=]/.test(rest)) continue;
      if (isForbiddenAuthorityShapeKey(assignment[1])) return true;
    }
  }
  const fingerprints = securityKeyFingerprints(text);
  for (let index = 0; index < fingerprints.length; index += 1) {
    const fingerprint = fingerprints[index];
    const familyCount = AUTHORITY_FAMILIES
      .filter((family) => fingerprint.includes(family))
      .length;
    if (familyCount >= 2) return true;
  }
  const states = ['grant', 'granted', 'active', 'enabled', 'issued', 'exposed', 'ref', 'value', 'material'];
  for (let index = 0; index < fingerprints.length; index += 1) {
    const fingerprint = fingerprints[index];
    if (AUTHORITY_FAMILIES.some((family) => fingerprint.includes(family)
      && states.some((state) => fingerprint.includes(state)))) return true;
  }
  return false;
}
