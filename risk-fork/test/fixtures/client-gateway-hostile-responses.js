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
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture-risk-forkd', version: '1.0.0' },
      },
    })}\n`);
    return;
  }
  if (message.method === 'tools/list') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{
          name: 'risk_fork_protect',
          description: 'Fixture-only exact Risk Fork gateway tool.',
          inputSchema: { type: 'object' },
        }],
      },
    })}\n`);
    return;
  }
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
  if (operation === 'root-progress-token') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'ordinary' }] },
      params: { _meta: { progressToken: 'response-must-not-use-request-exception' } },
    })}\n`);
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
  let result;
  if (operation === 'large') {
    result = { content: [{ type: 'text', text: 'x'.repeat(900_000) }] };
  } else if (operation === 'basic-auth') {
    result = { content: [{ type: 'text', text: 'Basic c3ludGhldGljOnBhc3M=' }] };
  } else if (operation === 'basic-auth-short') {
    result = { content: [{ type: 'text', text: 'Basic dTpw' }] };
  } else if (operation === 'basic-auth-unpadded') {
    result = { content: [{ type: 'text', text: 'Basic dTpwZA' }] };
  } else if (operation === 'basic-auth-overpadded') {
    result = { content: [{ type: 'text', text: 'Basic dTpw=' }] };
  } else if (operation === 'basic-auth-multiply-overpadded') {
    result = { content: [{ type: 'text', text: 'Basic dTpw===' }] };
  } else if (operation === 'basic-auth-space-folded') {
    result = { content: [{ type: 'text', text: 'Basic dT pw' }] };
  } else if (operation === 'basic-auth-tab-folded') {
    result = { content: [{ type: 'text', text: 'Basic dT\tpw' }] };
  } else if (operation === 'basic-auth-base64url') {
    result = { content: [{ type: 'text', text: 'Basic ZiA0dD86O30_MX4' }] };
  } else if (operation === 'basic-auth-dangling-alphanumeric') {
    result = { content: [{ type: 'text', text: 'Basic dTpwA' }] };
  } else if (operation === 'basic-auth-dangling-dash') {
    result = { content: [{ type: 'text', text: 'Basic dTpw-' }] };
  } else if (operation === 'basic-auth-dangling-underscore') {
    result = { content: [{ type: 'text', text: 'Basic dTpw_' }] };
  } else if (operation === 'basic-auth-ignored-dot') {
    result = { content: [{ type: 'text', text: 'Basic dTpw.' }] };
  } else if (operation === 'basic-auth-ignored-tilde') {
    result = { content: [{ type: 'text', text: 'Basic dTpw~' }] };
  } else if (operation === 'basic-auth-wrapped') {
    result = { content: [{ type: 'text', text: '(Basic dTpw)' }] };
  } else if (operation === 'proxy-authorization') {
    result = { content: [{ type: 'text', text: 'Proxy-Authorization: Basic c3ludGhldGljOnBhc3M=' }] };
  } else if (operation === 'proxy-authorization-pair') {
    result = {
      content: [{ type: 'text', text: 'ordinary' }],
      metadata: ['Proxy-Authorization', 'Negotiate synthetic-negotiate-token'],
    };
  } else if (operation === 'authorization-short-bearer') {
    result = {
      content: [{ type: 'text', text: 'ordinary' }],
      metadata: ['Authorization', 'Bearer x'],
    };
  } else if (operation === 'authorization-non-basic') {
    result = {
      content: [{ type: 'text', text: 'ordinary' }],
      metadata: ['Authorization', 'Negotiate x'],
    };
  } else if (operation === 'url-userinfo') {
    result = { content: [{ type: 'text', text: 'https://synthetic-user:synthetic-pass@example.test/path' }] };
  } else {
    result = { content: [{ type: 'text', text: 'ordinary' }], [sensitiveProperty]: 'abcdefgh' };
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
});
