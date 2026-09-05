'use strict';

const readline = require('node:readline');

const input = readline.createInterface({ input: process.stdin });
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
  process.stdout.write(
    `{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":{"content":[{"type":"text","text":"Bearer\\u0020synthetic1234"}]}}\n`,
  );
});
