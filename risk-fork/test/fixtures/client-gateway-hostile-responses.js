'use strict';

const readline = require('node:readline');

const input = readline.createInterface({ input: process.stdin });
const sensitiveProperties = {
  'sensitive-field-0': 'token',
  'sensitive-field-1': 'session_token',
  'sensitive-field-2': 'oauth_token',
  'sensitive-field-3': 'openAIAPIKey',
  'sensitive-field-4': 'openai_api_key',
  'sensitive-field-5': 'aws_secret_access_key',
  'sensitive-field-6': 'token_value',
  'sensitive-field-7': 'sessionTokenValue',
  'sensitive-field-8': 'githubTokenValue',
  'sensitive-field-9': 'openAIKey',
  'sensitive-field-10': 'AWSAccessKeyId',
  'sensitive-field-11': 'aws_access_key_id',
  'sensitive-field-12': 'accessKeyId',
  'sensitive-field-13': 'sessionTokenRaw',
  'sensitive-field-14': 'oauthTokenRaw',
  'sensitive-field-15': 'githubTokenRaw',
  'sensitive-field-16': 'tokenPayload',
  'sensitive-field-17': 'openAIKeyValue',
  'sensitive-field-18': 'awsAccessKeyIdValue',
};
const nonCanonicalNumbers = {
  'non-finite-number': '1e400',
  'negative-zero': '-0',
  'unsafe-integer': '9007199254740993',
  'underflow-number': '1e-400',
  'rounded-below-one': '0.99999999999999999',
  'rounded-decimal-tail': '0.100000000000000005',
};
const canonicalEquivalentNumbers = {
  'equivalent-decimal': '1.0',
  'equivalent-exponent': '1e3',
};
input.on('line', (line) => {
  const message = JSON.parse(line);
  const operation = message.params?.arguments?.operation;
  if (operation === 'malformed-utf8') {
    process.stdout.write(Buffer.concat([
      Buffer.from(`{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":{"value":"`),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}}\n'),
    ]));
    return;
  }
  if (operation === 'leading-bom') {
    process.stdout.write(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(`${JSON.stringify({
        jsonrpc: '2.0', id: message.id, result: { value: 'ordinary' },
      })}\n`),
    ]));
    return;
  }
  if (operation === 'deep') {
    process.stdout.write(
      `{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":${'['.repeat(10_000)}0${']'.repeat(10_000)}}\n`,
    );
    return;
  }
  const nonCanonicalNumber = nonCanonicalNumbers[operation];
  if (nonCanonicalNumber !== undefined) {
    process.stdout.write(
      `{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":{"value":${nonCanonicalNumber}}}\n`,
    );
    return;
  }
  const canonicalEquivalentNumber = canonicalEquivalentNumbers[operation];
  if (canonicalEquivalentNumber !== undefined) {
    process.stdout.write(
      `{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":{"value":${canonicalEquivalentNumber}}}\n`,
    );
    return;
  }
  const sensitiveProperty = sensitiveProperties[operation] ?? 'aws_secret_access_key';
  const result = operation === 'large'
    ? { content: [{ type: 'text', text: 'x'.repeat(900_000) }] }
    : { content: [{ type: 'text', text: 'ordinary' }], [sensitiveProperty]: 'abcdefgh' };
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
});
