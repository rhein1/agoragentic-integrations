// Risk Fork reuses Transaction Assurance's canonical key sorting and SHA-256
// digest helper, then binds every accepted JSON type to its canonical JSON
// bytes so textual JSON cannot collide with the value it represents.
// The stricter validation below is a fail-closed boundary: Transaction
// Assurance accepts ordinary JavaScript values for ergonomic local evidence,
import { createHash } from 'node:crypto';

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function detachArray(value) {
  Object.setPrototypeOf(value, null);
  return value;
}

function createDetachedArray(length) {
  return detachArray(new Array(length));
}

function defineArrayIndex(value, index, child) {
  Object.defineProperty(value, String(index), {
    value: child,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function ownStringKeys(value) {
  return detachArray(Object.keys(value));
}

function sortStrings(keys) {
  for (let index = 1; index < keys.length; index += 1) {
    const candidate = keys[index];
    let cursor = index - 1;
    while (cursor >= 0 && keys[cursor] > candidate) {
      keys[cursor + 1] = keys[cursor];
      cursor -= 1;
    }
    keys[cursor + 1] = candidate;
  }
  return keys;
}

function sortForCanonicalization(value) {
  if (Array.isArray(value)) {
    const sorted = createDetachedArray(value.length);
    for (let index = 0; index < value.length; index += 1) {
      defineArrayIndex(sorted, index, sortForCanonicalization(value[index]));
    }
    return sorted;
  }
  if (!isPlainObject(value)) return value;
  const sorted = Object.create(null);
  const keys = sortStrings(ownStringKeys(value));
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    Object.defineProperty(sorted, key, {
      value: sortForCanonicalization(value[key]),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return sorted;
}

function rawCanonicalize(value) {
  return JSON.stringify(sortForCanonicalization(value));
}

function rawSha256Ref(value) {
  const input = typeof value === 'string' ? value : rawCanonicalize(value);
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

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
    const descriptorKeys = ownStringKeys(descriptors);
    for (let index = 0; index < descriptorKeys.length; index += 1) {
      const key = descriptorKeys[index];
      const descriptor = descriptors[key];
      if (Array.isArray(value) && key === 'length') continue;
      if (!descriptor.enumerable || descriptor.get || descriptor.set) {
        throw new TypeError(`Canonical JSON contains a hidden or accessor field at ${path}.${key}`);
      }
    }

    if (Array.isArray(value)) {
      if (ownStringKeys(value).length !== value.length) {
        throw new TypeError(`Canonical JSON array is sparse or has extra fields at ${path}`);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
          throw new TypeError(`Canonical JSON array is sparse at ${path}[${index}]`);
        }
        assertJsonValue(descriptor.value, state, `${path}[${index}]`, depth + 1);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Canonical JSON contains a non-plain object at ${path}`);
    }
    for (let index = 0; index < descriptorKeys.length; index += 1) {
      const key = descriptorKeys[index];
      assertJsonValue(descriptors[key].value, state, `${path}.${key}`, depth + 1);
    }
  } finally {
    state.ancestors.delete(value);
  }
}

export function assertCanonicalJson(value) {
  assertJsonValue(value, { ancestors: new WeakSet(), nodes: 0 }, '$', 0);
  return value;
}

export function canonicalize(value) {
  assertCanonicalJson(value);
  return rawCanonicalize(value);
}

export function sha256Ref(value) {
  // Hash canonical JSON bytes for every supported type. Passing strings
  // through raw made textual JSON collide with the value it represented
  // (for example, "{}" and {}, or "null" and null).
  return rawSha256Ref(canonicalize(value));
}
