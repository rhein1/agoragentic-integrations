'use strict';

const readline = require('node:readline');

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  const operation = message.params?.arguments?.operation;
  if (operation === 'deep') {
    process.stdout.write(
      `{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":${'['.repeat(10_000)}0${']'.repeat(10_000)}}\n`,
    );
    return;
  }
  const result = operation === 'large'
    ? { content: [{ type: 'text', text: 'x'.repeat(900_000) }] }
    : { content: [{ type: 'text', text: 'ordinary' }], private_key: 'abcdefgh' };
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
});
