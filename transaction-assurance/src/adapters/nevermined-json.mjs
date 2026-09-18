import { createHash } from 'node:crypto';
import { types } from 'node:util';

export const LIMITS = Object.freeze({ bytes: 1048576, depth: 32, records: 1000, stringBytes: 65536, amountDigits: 78, decimals: 30, feeLegs: 32 });

/** Stable errors never include input values, filenames, keys, or parser excerpts. */
export class NeverminedImportError extends Error {
  constructor(code) {
    super(code);
    this.name = 'NeverminedImportError';
    this.code = code;
  }
}
const fail = (code) => { throw new NeverminedImportError(code); };
const forbiddenKey = (key) => ['__proto__', 'prototype', 'constructor'].includes(key);

function checkString(text) {
  if (Buffer.byteLength(text, 'utf8') > LIMITS.stringBytes) fail('limit_exceeded');
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('invalid_unicode');
    } else if (c >= 0xdc00 && c <= 0xdfff) fail('invalid_unicode');
  }
}

/** Strict literal JSON, including duplicate decoded property names at every level. */
export function parseNeverminedJson(input) {
  if (typeof input !== 'string' && !Buffer.isBuffer(input)) fail('invalid_input');
  if (Buffer.byteLength(input, 'utf8') > LIMITS.bytes) fail('input_too_large');
  let text;
  try { text = Buffer.isBuffer(input) ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input) : input; }
  catch { fail('invalid_utf8'); }
  let pos = 0;
  const ws = () => { while (/[\x20\x09\x0a\x0d]/.test(text[pos] ?? '\uFFFF')) pos++; };
  function string() {
    const start = pos++;
    let escaped = false;
    while (pos < text.length) {
      const char = text[pos++];
      if (!escaped && char === '"') {
        let value;
        try { value = JSON.parse(text.slice(start, pos)); } catch { fail('invalid_json'); }
        checkString(value);
        return value;
      }
      if (!escaped && char === '\\') escaped = true;
      else escaped = false;
    }
    fail('invalid_json');
  }
  function value(depth) {
    ws();
    const c = text[pos];
    if (c === '"') return string();
    if (c === '{' || c === '[') {
      if (depth >= LIMITS.depth) fail('limit_exceeded');
      const object = c === '{';
      const result = object ? Object.create(null) : [];
      const seen = new Set();
      const end = object ? '}' : ']';
      pos++; ws();
      if (text[pos] === end) { pos++; return result; }
      while (pos < text.length) {
        if (object) {
          if (text[pos] !== '"') fail('invalid_json');
          const key = string();
          if (seen.has(key)) fail('duplicate_key');
          if (forbiddenKey(key)) fail('unsafe_key');
          seen.add(key); ws();
          if (text[pos++] !== ':') fail('invalid_json');
          result[key] = value(depth + 1);
        } else {
          if (result.length >= LIMITS.records) fail('limit_exceeded');
          result.push(value(depth + 1));
        }
        ws();
        if (text[pos] === end) { pos++; return result; }
        if (text[pos++] !== ',') fail('invalid_json');
        ws();
      }
      fail('invalid_json');
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, pos)) { pos += literal.length; return result; }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(pos));
    if (!match) fail('invalid_json');
    pos += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) fail('unsafe_number');
    if (Number.isInteger(number) && !Number.isSafeInteger(number)) fail('unsafe_number');
    return number;
  }
  const result = value(0); ws();
  if (pos !== text.length) fail('invalid_json');
  return result;
}

/** Snapshot inert JSON data without executing getters, proxies, toJSON, or coercions. */
export function snapshotJson(input) {
  if (typeof input === 'string' || Buffer.isBuffer(input)) return parseNeverminedJson(input);
  const ancestors = new Set();
  let bytes = 0;
  function clone(value, depth) {
    if (types.isProxy(value)) fail('invalid_input');
    if (typeof value === 'string') { checkString(value); bytes += Buffer.byteLength(JSON.stringify(value)); }
    else if (typeof value === 'number') {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail('unsafe_number');
      bytes += String(value).length;
    } else if (value === null || typeof value === 'boolean') bytes += 5;
    else if (typeof value === 'object') {
      if (depth >= LIMITS.depth || ancestors.has(value)) fail('limit_exceeded');
      const array = Array.isArray(value);
      if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid_input');
      const keys = Reflect.ownKeys(value);
      const desc = Object.getOwnPropertyDescriptors(value);
      if (array && value.length > LIMITS.records) fail('limit_exceeded');
      const result = array ? [] : Object.create(null);
      ancestors.add(value);
      for (const key of keys) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string' || forbiddenKey(key)) fail('unsafe_key');
        checkString(key);
        if (!('value' in desc[key]) || !desc[key].enumerable) fail('invalid_input');
        if (array && !/^(0|[1-9]\d*)$/.test(key)) fail('invalid_input');
        bytes += array ? 1 : Buffer.byteLength(JSON.stringify(key)) + 2;
        result[key] = clone(desc[key].value, depth + 1);
      }
      if (array && Object.keys(result).length !== value.length) fail('invalid_input');
      ancestors.delete(value);
      bytes += 2;
      if (bytes > LIMITS.bytes) fail('input_too_large');
      return result;
    } else fail('invalid_input');
    if (bytes > LIMITS.bytes) fail('input_too_large');
    return value;
  }
  const result = clone(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.bytes) fail('input_too_large');
  return result;
}

/** RFC 8785 serialization for already validated I-JSON; emit keys directly, not via object enumeration. */
export function canonicalNeverminedJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalNeverminedJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalNeverminedJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const digestJson = (value) => `sha256:${createHash('sha256').update(canonicalNeverminedJson(value), 'utf8').digest('hex')}`;
export function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}
