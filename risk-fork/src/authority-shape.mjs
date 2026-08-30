const AUTHORITY_FAMILIES = Object.freeze([
  'authority', 'privilege', 'permission', 'capability', 'credential', 'secret',
  'token', 'bearer', 'handle', 'signer', 'wallet', 'session', 'keymaterial', 'privatekey',
  'signingkey', 'apikey',
]);

export function normalizeAuthorityShapeKey(value) {
  return String(value).normalize('NFKC').replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
}

export function isForbiddenAuthorityShapeKey(value) {
  const fingerprint = normalizeAuthorityShapeKey(value);
  return AUTHORITY_FAMILIES.some((family) => fingerprint.includes(family));
}

export function containsObviousCapabilityLikeText(value) {
  const text = String(value);
  if (/bearer\s+[a-z0-9._~+\/-]{8,}/i.test(text)) return true;
  for (const assignment of text.matchAll(/(?:^|[\s,;{])([^=:\n,;{}]{1,120})\s*[:=]/g)) {
    if (isForbiddenAuthorityShapeKey(assignment[1])) return true;
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
