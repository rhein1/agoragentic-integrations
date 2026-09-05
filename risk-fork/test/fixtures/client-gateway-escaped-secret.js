'use strict';

const readline = require('node:readline');

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  process.stdout.write(
    `{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":{"content":[{"type":"text","text":"Bearer\\u0020synthetic1234"}]}}\n`,
  );
});
