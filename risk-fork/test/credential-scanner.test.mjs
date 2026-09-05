import assert from 'node:assert/strict';
import test from 'node:test';

import { containsSerializedCredentialMaterial } from '../src/util.mjs';

const DECODER_IGNORED_ASCII = Array.from({ length: 0x7f }, (_, code) => code)
  .filter((code) => {
    const character = String.fromCharCode(code);
    return !/[A-Za-z0-9+/=_-]/.test(character);
  })
  .map((code) => String.fromCharCode(code));

const DECODER_IGNORED_UNICODE = [
  '\u0085',
  '\u00a0',
  '\u180e',
  '\u200b',
  '\u200c',
  '\u200d',
  '\u2060',
  '\ufeff',
];

test('Basic credential scanning matches Node decoding across ignored separators', () => {
  for (const separator of [...DECODER_IGNORED_ASCII, ...DECODER_IGNORED_UNICODE]) {
    const token = `dT${separator}pw`;
    assert.equal(
      Buffer.from(token, 'base64').toString('utf8'),
      'u:p',
      `fixture separator ${JSON.stringify(separator)} must be ignored by Node`,
    );
    assert.equal(
      containsSerializedCredentialMaterial(`Basic ${token}`),
      true,
      `scanner missed decoder-ignored separator ${JSON.stringify(separator)}`,
    );
  }
});

test('Basic credential scanning catches ignored separators at every encoded boundary', () => {
  const separators = ['!', ':', '[', ']', '()', '{}', '\u200b', '\u200d', '\u2060'];
  for (const separator of separators) {
    for (let index = 0; index <= 4; index += 1) {
      const token = `dTpw`.slice(0, index) + separator + `dTpw`.slice(index);
      assert.equal(Buffer.from(token, 'base64').toString('utf8'), 'u:p');
      assert.equal(
        containsSerializedCredentialMaterial(`Basic ${token}`),
        true,
        `scanner missed ${JSON.stringify(separator)} at boundary ${index}`,
      );
    }
  }
});

test('Basic credential scanning catches folded material in paths and JSON envelopes', () => {
  const candidates = [
    'Basic dT:pw',
    'Basic dT!pw',
    'Basic dT[pw',
    'Basic dT]pw',
    'Basic dT\u200bpw',
  ];
  for (const candidate of candidates) {
    assert.equal(
      containsSerializedCredentialMaterial(`/tmp/${candidate}/risk-forkd.js`),
      true,
    );
    assert.equal(
      containsSerializedCredentialMaterial(JSON.stringify({ params: { value: candidate } })),
      true,
    );
    assert.equal(
      containsSerializedCredentialMaterial(JSON.stringify({ result: { value: candidate } })),
      true,
    );
  }
});

test('Basic scanner follows low-byte decoding before Unicode whitespace classification', () => {
  for (const whitespace of ['\u202f', '\u205f']) {
    const token = `T${whitespace}QJOv8`;
    assert.equal(Buffer.from(token, 'base64').includes(0x3a), true);
    assert.equal(containsSerializedCredentialMaterial(`Basic ${token}`), true);
  }
});

test('nested Basic text does not reset an already active decoder', () => {
  const token = 'IH!Basic 6';
  assert.equal(Buffer.from(token, 'base64').includes(0x3a), true);
  assert.equal(containsSerializedCredentialMaterial(`Basic ${token}`), true);
});

test('Basic scanner covers deterministic Node and whitespace-fold decoding oracles', () => {
  let randomState = 0x6d2b79f5;
  const next = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState;
  };
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=_-!:.[]{}()~ \t\n\u200b\u200d\u202f\u205f';

  for (let iteration = 0; iteration < 20_000; iteration += 1) {
    let token = '';
    const length = 1 + (next() % 48);
    for (let index = 0; index < length; index += 1) {
      token += alphabet[next() % alphabet.length];
    }
    if ((iteration & 31) === 0) {
      const insertion = next() % (token.length + 1);
      token = `${token.slice(0, insertion)}Basic ${token.slice(insertion)}`;
    }

    const nodeDecodedColon = Buffer.from(token, 'base64').includes(0x3a);
    const whitespaceFoldedColon = Buffer.from(token.replace(/\s/gu, ''), 'base64').includes(0x3a);
    if (nodeDecodedColon || whitespaceFoldedColon) {
      assert.equal(
        containsSerializedCredentialMaterial(`Basic ${token}`),
        true,
        `scanner missed deterministic candidate ${iteration}`,
      );
    }
  }
});

test('Basic credential scanning remains bounded without candidate allocation', () => {
  const separatorRun = '!'.repeat(1_000_000);
  assert.equal(
    containsSerializedCredentialMaterial(`Basic dT${separatorRun}pw`),
    true,
  );
  assert.equal(
    containsSerializedCredentialMaterial(`Basic dT${separatorRun}`),
    false,
  );
});

test('Basic scanner preserves padding and embedded-identifier boundaries', () => {
  assert.equal(containsSerializedCredentialMaterial('Basic dT=pw'), false);
  assert.equal(containsSerializedCredentialMaterial('Basic dT==pw'), false);
  assert.equal(containsSerializedCredentialMaterial('Basic dT\u{1f512}pw'), false);
  assert.equal(containsSerializedCredentialMaterial('run a basic test'), false);
  assert.equal(containsSerializedCredentialMaterial('nonbasic dT!pw'), false);
  assert.equal(containsSerializedCredentialMaterial('non-basic dT!pw'), false);
  assert.equal(containsSerializedCredentialMaterial('non.basic dT!pw'), false);
  assert.equal(containsSerializedCredentialMaterial('non_basic dT!pw'), false);
});
