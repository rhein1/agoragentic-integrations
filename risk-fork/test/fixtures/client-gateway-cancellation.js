'use strict';

const readline = require('node:readline');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const input = readline.createInterface({ input: process.stdin });
const pending = new Map();
let oldestCancelledRequestId = null;
let gatewayOperationCount = 0;

function writeResult(id, operation) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify({ status: 'fixture_only', operation }) }],
    },
  })}\n`);
}

input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'notifications/cancelled') {
    const request = pending.get(message.params.requestId);
    if (request?.respondAfterCancellation) {
      pending.delete(message.params.requestId);
      writeResult(message.params.requestId, request.operation);
      return;
    }
    if (request?.suppressAfterCancellation) {
      if (request.timer) clearTimeout(request.timer);
      pending.delete(message.params.requestId);
    }
    return;
  }
  if (message.id === undefined) return;
  gatewayOperationCount += 1;
  writeFileSync(
    path.join(__dirname, 'gateway-operation-count.txt'),
    String(gatewayOperationCount),
  );
  const operation = message.params?.arguments?.operation;
  if (operation === 'aba-old') {
    if (oldestCancelledRequestId === null) oldestCancelledRequestId = message.id;
    pending.set(message.id, { timer: null, suppressAfterCancellation: true });
    return;
  }
  if (operation === 'aba-new') {
    setTimeout(() => writeResult(oldestCancelledRequestId, 'aba-old'), 10);
    setTimeout(() => writeResult(message.id, 'aba-new'), 35);
    return;
  }
  if (operation === 'cancel-no-response' || operation === 'late-after-cancel') {
    const timer = setTimeout(() => {
      pending.delete(message.id);
      writeResult(message.id, operation);
    }, 75);
    pending.set(message.id, {
      timer,
      suppressAfterCancellation: operation === 'cancel-no-response',
    });
    return;
  }
  if (operation === 'terminal-on-cancel') {
    pending.set(message.id, {
      operation,
      respondAfterCancellation: true,
      suppressAfterCancellation: false,
      timer: null,
    });
    return;
  }
  if (operation === 'gateway-hang') {
    pending.set(message.id, { timer: null, suppressAfterCancellation: true });
    return;
  }
  if (operation === 'duplicate-response') {
    writeResult(message.id, operation);
    setTimeout(() => writeResult(message.id, operation), 10);
    return;
  }
  writeResult(message.id, operation ?? message.method);
});
