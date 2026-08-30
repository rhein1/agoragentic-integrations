import { createHash } from 'node:crypto';

// Keep the canonical primitive package-local. Published-package dry copies do
// not include a sibling transaction-assurance checkout, and a security binding
// must not change merely because a monorepo-relative source tree is absent.

const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const MAX_STRING_BYTES = 16 * 1024 * 1024;

function assertJsonValue(value, state, path, depth) {
  if (depth > MAX_DEPTH) throw new TypeError(`Canonical JSON exceeds ${MAX_DEPTH} levels at ${path}`);
  state.nodes += 1;
  if (state.nodes > MAX_NODES) throw new TypeError(`Canonical JSON exceeds ${MAX_NODES} values`);

  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) {
      throw new TypeError(`Canonical JSON string is too large at ${path}`);
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`Canonical JSON number is not finite and unambiguous at ${path}`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError(`Canonical JSON integer is outside the safe range at ${path}`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Canonical JSON contains a non-JSON value at ${path}`);
  }
  if (state.ancestors.has(value)) throw new TypeError(`Canonical JSON contains a cycle at ${path}`);
  state.ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`Canonical JSON contains a symbol key at ${path}`);
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue;
      if (!descriptor.enumerable || descriptor.get || descriptor.set) {
        throw new TypeError(`Canonical JSON contains a hidden or accessor field at ${path}.${key}`);
      }
    }

    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) {
        throw new TypeError(`Canonical JSON array is sparse or has extra fields at ${path}`);
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`Canonical JSON array is sparse at ${path}[${index}]`);
        }
        assertJsonValue(value[index], state, `${path}[${index}]`, depth + 1);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Canonical JSON contains a non-plain object at ${path}`);
    }
    for (const [key, child] of Object.entries(value)) {
      assertJsonValue(child, state, `${path}.${key}`, depth + 1);
    }
  } finally {
    state.ancestors.delete(value);
  }
}

export function assertCanonicalJson(value) {
  assertJsonValue(value, { ancestors: new WeakSet(), nodes: 0 }, '$', 0);
  return value;
}

function sortForCanonicalization(value) {
  if (Array.isArray(value)) return value.map(sortForCanonicalization);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortForCanonicalization(value[key])]),
  );
}

export function canonicalize(value) {
  assertCanonicalJson(value);
  return JSON.stringify(sortForCanonicalization(value));
}

export function sha256Ref(value) {
  // Hash canonical JSON bytes for every supported type. Passing strings
  // through raw made textual JSON collide with the value it represented
  // (for example, "{}" and {}, or "null" and null).
  return `sha256:${createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')}`;
}
