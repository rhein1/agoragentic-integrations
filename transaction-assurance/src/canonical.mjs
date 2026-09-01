import { createHash } from 'node:crypto';

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sortForCanonicalization(value) {
  if (Array.isArray(value)) return value.map(sortForCanonicalization);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortForCanonicalization(value[key])]),
  );
}

export function canonicalize(value) {
  return JSON.stringify(sortForCanonicalization(value));
}

export function sha256Ref(value) {
  const input = typeof value === 'string' ? value : canonicalize(value);
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}
