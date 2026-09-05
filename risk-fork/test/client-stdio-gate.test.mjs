import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { RISK_FORK_CLIENT_GATE_MAX_GATEWAY_BYTES } from '../src/client-adoption.mjs';
import { containsSerializedCredentialMaterial } from '../src/util.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = path.dirname(packageRoot);
const gateEntrypoint = path.join(packageRoot, 'clients', 'one-tool-stdio-gate.mjs');
const fixtureRoot = path.join(packageRoot, 'test', 'fixtures');
const serveTest = process.platform === 'win32' ? test.skip : test;
const utilEntrypointUrl = new URL('../src/util.mjs', import.meta.url).href;
const ECMASCRIPT_WHITESPACE_CHARACTERS = Object.freeze([
  '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680',
  '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005',
  '\u2006', '\u2007', '\u2008', '\u2009', '\u200a', '\u2028',
  '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff',
]);

async function sha256(filename) {
  return `sha256:${createHash('sha256').update(await readFile(filename)).digest('hex')}`;
}

function withTimeout(promise, milliseconds) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), milliseconds);
    timeout.unref();
    promise.then((value) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
}

async function isProcessExecutable(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const processStat = await readFile(`/proc/${pid}/stat`, 'utf8');
      return !/^\d+ \(.*\) Z /.test(processStat);
    }
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH' || error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function startGate(fixtureName, { consumeOutput = true, ready = true } = {}) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'risk-fork-client-gate-'));
  const gateway = path.join(temporaryRoot, 'risk-forkd.js');
  await copyFile(path.join(fixtureRoot, fixtureName), gateway);
  const child = spawn(process.execPath, [
    gateEntrypoint,
    'serve',
    '--gateway-entrypoint', gateway,
    '--gateway-sha256', await sha256(gateway),
  ], {
    cwd: packageRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  const messages = [];
  const stderr = [];
  const output = (consumeOutput || ready) ? createInterface({ input: child.stdout }) : null;
  const exit = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  if (output) {
    output.on('line', (line) => {
      const message = JSON.parse(line);
      messages.push(message);
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      waiter.resolve(message);
    });
  }
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  function request(id, method, params = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}: ${stderr.join('')}`));
      }, 5000);
      pending.set(id, {
        resolve(message) {
          clearTimeout(timer);
          resolve(message);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async function cleanup() {
    output?.close();
    if (child.exitCode === null && !child.stdin.destroyed) child.stdin.end();
    if (child.exitCode === null) {
      const outcome = await withTimeout(exit, 2_000);
      if (outcome === null && !child.killed) {
        child.kill();
        await exit;
      }
    } else {
      await exit;
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  const session = {
    child, cleanup, exit, gateway, messages, request, stderr, temporaryRoot,
  };
  if (ready) {
    try {
      const initialized = await request('__test_initialize__', 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'client-gate-test', version: '1.0.0' },
      });
      assert.equal(initialized.error, undefined, 'test gateway initialization must succeed');
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', method: 'notifications/initialized', params: {},
      })}\n`);
      const listed = await request('__test_tools_list__', 'tools/list');
      assert.equal(listed.error, undefined, 'test gateway inventory must validate');
      if (!consumeOutput) {
        output?.close();
        child.stdout.pause();
      }
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
  return session;
}

serveTest('stdio client gate exposes and forwards only risk_fork_protect', async () => {
  const session = await startGate('client-gateway-good.js', { ready: false });
  try {
    const initialized = await session.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'client-gate-test', version: '1.0.0' },
    });
    assert.equal(initialized.error, undefined);
    session.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/initialized', params: {},
    })}\n`);
    session.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999 },
    })}\n`);
    const listed = await session.request(2, 'tools/list');
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['risk_fork_protect']);

    const rejected = await session.request(3, 'tools/call', {
      name: 'unexpected_bypass', arguments: {},
    });
    assert.equal(rejected.error.code, -32602);
    assert.match(rejected.error.message, /Only risk_fork_protect/);

    session.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'risk_fork_protect', arguments: { operation: 'notification-bypass' } },
    })}\n`);

    const called = await session.request(4, 'tools/call', {
      name: 'risk_fork_protect', arguments: { operation: 'fixture-read' },
    });
    assert.equal(called.error, undefined);
    assert.deepEqual(JSON.parse(called.result.content[0].text), {
      status: 'fixture_only', operation: 'fixture-read', invocation_count: 1,
    });

    const forbidden = await session.request(5, 'resources/list');
    assert.equal(forbidden.error.code, -32601);
  } finally {
    await session.cleanup();
  }
});

serveTest('stdio client gate allows only standard params._meta progress tokens', async (t) => {
  for (const [name, progressToken] of [['string', 'progress-fixture-1'], ['integer', 17]]) {
    await t.test(`${name} progress token`, async () => {
      const session = await startGate('client-gateway-good.js');
      try {
        const called = await session.request(1, 'tools/call', {
          name: 'risk_fork_protect',
          arguments: { operation: `progress-${name}` },
          _meta: { progressToken },
        });
        assert.equal(called.error, undefined);
      } finally {
        await session.cleanup();
      }
    });
  }

  await t.test('progress token value remains credential-scanned', async () => {
    const session = await startGate('client-gateway-good.js');
    try {
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'risk_fork_protect',
          arguments: { operation: 'progress-secret' },
          _meta: { progressToken: 'Basic c3ludGhldGljOnBhc3M=' },
        },
      })}\n`);
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null);
      assert.equal(outcome.code, 78);
      assert.doesNotMatch(session.stderr.join(''), /c3ludGhldGljOnBhc3M|uncaught|node:internal/i);
    } finally {
      await session.cleanup();
    }
  });

  await t.test('progressToken outside request params._meta remains rejected', async () => {
    const session = await startGate('client-gateway-good.js');
    try {
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'risk_fork_protect',
          arguments: { operation: 'nested-progress', progressToken: 'ordinary' },
        },
      })}\n`);
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null);
      assert.equal(outcome.code, 78);
    } finally {
      await session.cleanup();
    }
  });

  await t.test('gateway response nesting cannot imitate request progress metadata', async () => {
    const session = await startGate('client-gateway-hostile-responses.js');
    try {
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'risk_fork_protect', arguments: { operation: 'root-progress-token' },
        },
      })}\n`);
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null);
      assert.equal(outcome.code, 78);
    } finally {
      await session.cleanup();
    }
  });
});

serveTest('stdio client gate requires a fresh validated lifecycle before tools/call', async () => {
  const session = await startGate('client-gateway-good.js', { ready: false });
  try {
    async function expectLifecycleRejection(id) {
      const rejected = await session.request(id, 'tools/call', {
        name: 'risk_fork_protect', arguments: { operation: 'must-not-forward' },
      });
      assert.equal(rejected.error.code, -32004);
    }

    await expectLifecycleRejection(1);
    const failedInitialize = await session.request(2, 'initialize', { mode: 'error' });
    assert.equal(failedInitialize.error.code, -32090);
    await expectLifecycleRejection(3);

    const initialized = await session.request(4, 'initialize');
    assert.equal(initialized.error, undefined);
    await expectLifecycleRejection(5);

    const failedList = await session.request(6, 'tools/list', { mode: 'error' });
    assert.equal(failedList.error.code, -32091);
    await expectLifecycleRejection(7);

    const listed = await session.request(10, 'tools/list');
    assert.equal(listed.error, undefined);
    const firstCall = await session.request(11, 'tools/call', {
      name: 'risk_fork_protect', arguments: { operation: 'authorized-once' },
    });
    assert.equal(firstCall.error, undefined);
    assert.match(firstCall.result.content[0].text, /"invocation_count":1/);

    const secondFailedList = await session.request(12, 'tools/list', { mode: 'error' });
    assert.equal(secondFailedList.error.code, -32091);
    await expectLifecycleRejection(13);
    const relisted = await session.request(14, 'tools/list');
    assert.equal(relisted.error, undefined);

    const secondFailedInitialize = await session.request(15, 'initialize', { mode: 'error' });
    assert.equal(secondFailedInitialize.error.code, -32090);
    await expectLifecycleRejection(16);

    const reinitialized = await session.request(17, 'initialize');
    assert.equal(reinitialized.error, undefined);
    const finalList = await session.request(18, 'tools/list');
    assert.equal(finalList.error, undefined);
    session.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 19, method: 'tools/list', params: { mode: 'hang' },
    })}\n`);
    const concurrentList = await session.request(20, 'tools/list');
    assert.equal(concurrentList.error.code, -32005);
    session.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 19 },
    })}\n`);
    await expectLifecycleRejection(21);
  } finally {
    await session.cleanup();
  }
});

serveTest('stdio client gate serializes and invalidates cancelled initialize attempts', async () => {
  const session = await startGate('client-gateway-good.js');
  try {
    session.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { mode: 'hang' },
    })}\n`);
    const concurrentInitialize = await session.request(2, 'initialize');
    assert.equal(concurrentInitialize.error.code, -32005);
    session.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 },
    })}\n`);
    const rejected = await session.request(3, 'tools/call', {
      name: 'risk_fork_protect', arguments: { operation: 'must-not-forward' },
    });
    assert.equal(rejected.error.code, -32004);
  } finally {
    await session.cleanup();
  }
});

serveTest('stdio client gate fails closed when a gateway advertises any second tool', async () => {
  const session = await startGate('client-gateway-extra-tool.js', { ready: false });
  try {
    const initialized = await session.request(1, 'initialize');
    assert.equal(initialized.error, undefined);
    const listed = await session.request(2, 'tools/list');
    assert.equal(listed.error.code, -32001);
    assert.equal(listed.error.data.reason_code, 'RISK_FORK_GATEWAY_TOOL_SURFACE_INVALID');
    const outcome = await session.exit;
    assert.equal(outcome.code, 78);
  } finally {
    await session.cleanup();
  }
});

serveTest('stdio client gate rejects gateway-to-client requests even when they reuse a pending id', async () => {
  const session = await startGate('client-gateway-good.js');
  try {
    const bypass = await session.request(1, 'tools/call', {
      name: 'risk_fork_protect', arguments: { operation: 'server-request-bypass' },
    });
    assert.equal(bypass.error.code, -32001);
    assert.match(bypass.error.message, /requests and notifications are outside/);
    const outcome = await session.exit;
    assert.equal(outcome.code, 78);
  } finally {
    await session.cleanup();
  }
});

serveTest('stdio client gate bounds concurrent pending gateway requests', async () => {
  const session = await startGate('client-gateway-good.js');
  try {
    for (let id = 1; id <= 16; id += 1) {
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'risk_fork_protect', arguments: { operation: 'hang' } },
      })}\n`);
    }
    const rejected = await session.request(17, 'tools/call', {
      name: 'risk_fork_protect', arguments: { operation: 'hang' },
    });
    assert.equal(rejected.error.code, -32002);
    assert.match(rejected.error.message, /At most 16/);
  } finally {
    await session.cleanup();
  }
});

serveTest('stdio client gate cancellation releases slots and tolerates one bounded late response', async (t) => {
  await t.test('cancelled requests need no gateway response to release every pending slot', async () => {
    const session = await startGate('client-gateway-cancellation.js');
    try {
      for (let id = 1; id <= 16; id += 1) {
        session.child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: 'risk_fork_protect', arguments: { operation: 'cancel-no-response' },
          },
        })}\n`);
      }
      for (let requestId = 1; requestId <= 16; requestId += 1) {
        session.child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId, reason: 'test cancellation' },
        })}\n`);
      }
      const called = await session.request(17, 'tools/call', {
        name: 'risk_fork_protect', arguments: { operation: 'ordinary' },
      });
      assert.equal(called.error, undefined);
      assert.equal(session.child.exitCode, null);
      await delay(150);
      assert.deepEqual(
        session.messages.filter((message) => Number.isInteger(message.id) && message.id <= 16),
        [],
      );
    } finally {
      await session.cleanup();
    }
  });

  await t.test('cancelled and active gateway backlogs remain capped at 16 and 32', async () => {
    const session = await startGate('client-gateway-cancellation.js');
    try {
      for (let requestId = 1; requestId <= 16; requestId += 1) {
        session.child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0', id: requestId, method: 'tools/call', params: {
            name: 'risk_fork_protect', arguments: { operation: 'cancel-no-response' },
          },
        })}\n`);
        session.child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId },
        })}\n`);
      }
      for (let requestId = 17; requestId <= 32; requestId += 1) {
        session.child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0', id: requestId, method: 'tools/call', params: {
            name: 'risk_fork_protect', arguments: { operation: 'gateway-hang' },
          },
        })}\n`);
      }
      const rejected = await session.request(33, 'tools/call', {
        name: 'risk_fork_protect', arguments: { operation: 'gateway-hang' },
      });
      assert.equal(rejected.error.code, -32003);
      assert.match(rejected.error.message, /At most 32 total gateway requests/);

      const countFile = path.join(session.temporaryRoot, 'gateway-operation-count.txt');
      let gatewayOperationCount = 0;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          gatewayOperationCount = Number.parseInt(await readFile(countFile, 'utf8'), 10);
        } catch {}
        if (gatewayOperationCount === 32) break;
        await delay(10);
      }
      assert.equal(gatewayOperationCount, 32);

      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 17 },
      })}\n`);
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null, 'cancelled backlog overflow must terminate promptly');
      assert.equal(outcome.code, 78);
      assert.equal(Number.parseInt(await readFile(countFile, 'utf8'), 10), 32);
      assert.deepEqual(
        session.messages.filter((message) => Number.isInteger(message.id) && message.id <= 16),
        [],
      );
    } finally {
      await session.cleanup();
    }
  });

  await t.test('one late response to a cancelled request is validated and discarded', async () => {
    const session = await startGate('client-gateway-cancellation.js');
    try {
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'risk_fork_protect', arguments: { operation: 'late-after-cancel' },
        },
      })}\n`);
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 },
      })}\n`);
      await delay(150);
      assert.equal(session.child.exitCode, null);
      assert.deepEqual(session.messages.filter((message) => message.id === 1), []);
      const called = await session.request(2, 'tools/call', {
        name: 'risk_fork_protect', arguments: { operation: 'ordinary' },
      });
      assert.equal(called.error, undefined);
    } finally {
      await session.cleanup();
    }
  });

  await t.test('a duplicate response after terminal removal fails closed as unknown', async () => {
    const session = await startGate('client-gateway-cancellation.js');
    try {
      const called = await session.request(1, 'tools/call', {
        name: 'risk_fork_protect', arguments: { operation: 'duplicate-response' },
      });
      assert.equal(called.error, undefined);
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null, 'duplicate response must terminate promptly');
      assert.equal(outcome.code, 78);
      assert.equal(session.messages.filter((message) => message.id === 1).length, 1);
    } finally {
      await session.cleanup();
    }
  });

  await t.test('a cancelled client id stays tombstoned against request and cancellation ABA', async () => {
    const session = await startGate('client-gateway-cancellation.js');
    try {
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'risk_fork_protect', arguments: { operation: 'aba-old' },
        },
      })}\n`);
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 },
      })}\n`);
      const rejected = await session.request(1, 'tools/call', {
        name: 'risk_fork_protect', arguments: { operation: 'aba-new' },
      });
      assert.equal(rejected.error.code, -32600);
      assert.match(rejected.error.message, /duplicate|retired/);
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 },
      })}\n`);
      const called = await session.request(2, 'tools/call', {
        name: 'risk_fork_protect', arguments: { operation: 'ordinary' },
      });
      assert.equal(called.error, undefined);
      assert.equal(session.child.exitCode, null);
      assert.equal(session.messages.filter((message) => message.id === 1).length, 1);
    } finally {
      await session.cleanup();
    }
  });

  await t.test('a cancelled client id stays retired after terminal response and stale cancel', async () => {
    const session = await startGate('client-gateway-cancellation.js');
    try {
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'risk_fork_protect', arguments: { operation: 'terminal-on-cancel' },
        },
      })}\n`);
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 },
      })}\n`);
      const terminalBarrier = await session.request(2, 'tools/call', {
        name: 'risk_fork_protect', arguments: { operation: 'ordinary' },
      });
      assert.equal(terminalBarrier.error, undefined);
      const rejected = await session.request(1, 'tools/call', {
        name: 'risk_fork_protect', arguments: { operation: 'aba-new' },
      });
      assert.equal(rejected.error.code, -32600);
      assert.match(rejected.error.message, /retired request id/);
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 },
      })}\n`);
      const called = await session.request(3, 'tools/call', {
        name: 'risk_fork_protect', arguments: { operation: 'ordinary' },
      });
      assert.equal(called.error, undefined);
      assert.equal(session.child.exitCode, null);
      assert.equal(
        session.messages.filter((message) => message.id === 1 && message.error === undefined).length,
        0,
      );
    } finally {
      await session.cleanup();
    }
  });

  await t.test('retired cancellation ids are bounded to 1024 for the gate lifetime', async () => {
    const session = await startGate('client-gateway-cancellation.js');
    try {
      for (let batchStart = 1; batchStart <= 1024; batchStart += 16) {
        for (let requestId = batchStart; requestId < batchStart + 16; requestId += 1) {
          session.child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0', id: requestId, method: 'tools/call', params: {
              name: 'risk_fork_protect', arguments: { operation: 'terminal-on-cancel' },
            },
          })}\n`);
          session.child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId },
          })}\n`);
        }
        const barrier = await session.request(`retired-barrier-${batchStart}`, 'tools/call', {
          name: 'risk_fork_protect', arguments: { operation: 'ordinary' },
        });
        assert.equal(barrier.error, undefined);
      }
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1025, method: 'tools/call', params: {
          name: 'risk_fork_protect', arguments: { operation: 'terminal-on-cancel' },
        },
      })}\n`);
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1025 },
      })}\n`);
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null, 'retired-id capacity overflow must terminate promptly');
      assert.equal(outcome.code, 78);
      assert.doesNotMatch(session.stderr.join(''), /uncaught|node:internal/i);
    } finally {
      await session.cleanup();
    }
  });

  await t.test('malformed cancellation request ids fail closed', async () => {
    const session = await startGate('client-gateway-cancellation.js');
    try {
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: {} },
      })}\n`);
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null, 'malformed cancellation must terminate promptly');
      assert.equal(outcome.code, 78);
      assert.doesNotMatch(session.stderr.join(''), /uncaught|node:internal/i);
    } finally {
      await session.cleanup();
    }
  });
});

serveTest('stdio client gate leaves the exact schema to the gateway but requires an object input', async () => {
  const session = await startGate('client-gateway-invalid-schema.js', { ready: false });
  try {
    const initialized = await session.request(1, 'initialize');
    assert.equal(initialized.error, undefined);
    const listed = await session.request(2, 'tools/list');
    assert.equal(listed.error.code, -32001);
    assert.equal(listed.error.data.reason_code, 'RISK_FORK_GATEWAY_TOOL_SURFACE_INVALID');
    const outcome = await session.exit;
    assert.equal(outcome.code, 78);
  } finally {
    await session.cleanup();
  }
});

serveTest('stdio client gate verifies exact gateway bytes and current gateway stays unavailable', async () => {
  const mismatch = spawnSync(process.execPath, [
    gateEntrypoint,
    'serve',
    '--gateway-entrypoint', path.join(repositoryRoot, 'mcp', 'risk-forkd.js'),
    '--gateway-sha256', `sha256:${'0'.repeat(64)}`,
  ], { cwd: packageRoot, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(mismatch.status, 78);
  assert.equal(JSON.parse(mismatch.stderr).reason_code, 'RISK_FORK_CLIENT_GATE_HASH_MISMATCH');

  const currentGateway = path.join(repositoryRoot, 'mcp', 'risk-forkd.js');
  const unavailable = spawnSync(process.execPath, [
    gateEntrypoint,
    'serve',
    '--gateway-entrypoint', currentGateway,
    '--gateway-sha256', await sha256(currentGateway),
  ], { cwd: packageRoot, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(unavailable.status, 78);
  assert.equal(unavailable.stdout, '');

});

test('stdio client gate reports its exact platform and resource boundaries', async () => {
  const status = spawnSync(process.execPath, [gateEntrypoint, 'status'], {
    cwd: packageRoot, encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), {
    schema: 'agoragentic.risk-fork.client-stdio-gate-status.v1',
    mode: 'source_only_default_off',
    expected_tool_inventory: ['risk_fork_protect'],
    gateway_process_started: false,
    gateway_qualified: false,
    gateway_runtime_closure_bound: false,
    tool_input_schema_bound: false,
    provider_authority_granted: false,
    executor_bound: false,
    hosted_authority_granted: false,
    production_authority_granted: false,
    live_traffic_protected: false,
    inherited_environment_forwarded: false,
    recognized_credential_pattern_matches_forwarded: false,
    serve_supported_on_current_platform: process.platform !== 'win32',
    descendant_containment: process.platform === 'win32'
      ? 'unavailable'
      : 'posix_process_group',
    max_active_gateway_requests: 16,
    max_cancelled_gateway_requests: 16,
    max_total_gateway_requests: 32,
    max_retired_cancelled_client_ids: 1024,
    max_gateway_stderr_bytes: 65536,
    max_concurrent_lifecycle_requests: 1,
    provider_calls: 0,
    network_implementation_included: false,
  });

  const source = await readFile(gateEntrypoint, 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|https?\.request|connectRemoteClient|commitPrepared)\b/);
  assert.doesNotMatch(source, /from ['"](?:node:)?(?:dns|http|https|net|tls|undici)['"]/);
});

test('stdio client gate refuses Windows serve before starting gateway code', {
  skip: process.platform !== 'win32' ? 'Windows-specific descendant-containment boundary' : false,
}, async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'risk-fork-client-gate-win32-'));
  const gateway = path.join(temporaryRoot, 'risk-forkd.js');
  const marker = path.join(temporaryRoot, 'gateway-started.txt');
  try {
    await copyFile(path.join(fixtureRoot, 'client-gateway-start-marker.js'), gateway);
    const refused = spawnSync(process.execPath, [
      gateEntrypoint,
      'serve',
      '--gateway-entrypoint', gateway,
      '--gateway-sha256', await sha256(gateway),
    ], { cwd: packageRoot, encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.equal(refused.status, 78);
    assert.equal(refused.stdout, '');
    assert.equal(
      JSON.parse(refused.stderr).reason_code,
      'RISK_FORK_CLIENT_GATE_PLATFORM_UNSUPPORTED',
    );
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

serveTest('stdio client gate preserves a clean exit after client EOF', async () => {
  const session = await startGate('client-gateway-good.js');
  try {
    session.child.stdin.end();
    const outcome = await session.exit;
    assert.deepEqual(outcome, { code: 0, signal: null });
    assert.doesNotMatch(session.stderr.join(''), /EPIPE|uncaught|node:internal/i);
  } finally {
    await session.cleanup();
  }
});

test('stdio client gate cleans inherited POSIX gateway descendants after clean EOF', {
  skip: process.platform === 'win32' ? 'POSIX clean-EOF process-group boundary' : false,
}, async () => {
  const session = await startGate('client-gateway-clean-eof-descendant.js', { ready: false });
  let descendantPid = null;
  try {
    const pidFile = path.join(session.temporaryRoot, 'descendant.pid');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        descendantPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
        break;
      } catch {
        await delay(10);
      }
    }
    assert.equal(Number.isSafeInteger(descendantPid), true, 'descendant pid must be recorded');
    session.child.stdin.end();
    const outcome = await withTimeout(session.exit, 2_500);
    assert.notEqual(outcome, null, 'clean-EOF descendant cleanup must remain bounded');
    assert.deepEqual(outcome, { code: 0, signal: null });
    await delay(100);
    assert.equal(await isProcessExecutable(descendantPid), false, 'descendant must not remain executable');
    assert.doesNotMatch(session.stderr.join(''), /uncaught|node:internal/i);
  } finally {
    if (Number.isSafeInteger(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch {}
    }
    await session.cleanup();
  }
});

test('stdio client gate fails closed when the gateway response stream ends early', {
  skip: process.platform === 'win32' ? 'POSIX response-stream EOF boundary' : false,
}, async (t) => {
  await t.test('idle gateway', async () => {
    const session = await startGate('client-gateway-closes-output.js', { ready: false });
    try {
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null, 'idle response-stream EOF must terminate promptly');
      assert.equal(outcome.code, 78);
      assert.doesNotMatch(session.stderr.join(''), /uncaught|node:internal/i);
    } finally {
      await session.cleanup();
    }
  });

  await t.test('pending request', async () => {
    const session = await startGate('client-gateway-closes-output.js', { ready: false });
    try {
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
      })}\n`);
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null, 'pending response-stream EOF must terminate promptly');
      assert.equal(outcome.code, 78);
      assert.doesNotMatch(session.stderr.join(''), /uncaught|node:internal/i);
    } finally {
      await session.cleanup();
    }
  });
});

serveTest('stdio client gate contains closed and backpressured gateway pipe errors', async (t) => {
  await t.test('closed child input', async () => {
    const session = await startGate('client-gateway-closed-input.js', { ready: false });
    try {
      const marker = path.join(session.temporaryRoot, 'gateway-input-closed.txt');
      let inputClosed = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await readFile(marker);
          inputClosed = true;
          break;
        } catch {
          await delay(10);
        }
      }
      assert.equal(inputClosed, true, 'fixture must close gateway input before the probe');
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
        params: { payload: 'closed-'.repeat(25_000) },
      })}\n`);
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null, 'closed-input failure must terminate promptly');
      assert.equal(outcome.code, 78);
      assert.doesNotMatch(session.stderr.join(''), /EPIPE|uncaught|node:internal/i);
    } finally {
      await session.cleanup();
    }
  });

  await t.test('backpressured child input', async () => {
    const session = await startGate('client-gateway-no-input-read.js', { ready: false });
    try {
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'x'.repeat(900_000) } },
      })}\n`);
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null, 'backpressure failure must terminate promptly');
      assert.equal(outcome.code, 78);
      assert.doesNotMatch(session.stderr.join(''), /EPIPE|uncaught|node:internal/i);
    } finally {
      await session.cleanup();
    }
  });
});

serveTest('stdio client gate bounds cumulative gateway stderr while idle', async () => {
  const session = await startGate('client-gateway-stderr-flood.js', { ready: false });
  try {
    const outcome = await withTimeout(session.exit, 2_000);
    assert.notEqual(outcome, null, 'idle stderr flood must terminate promptly');
    assert.equal(outcome.code, 78);
    assert.ok(Buffer.byteLength(session.stderr.join('')) < 4096);
    assert.doesNotMatch(session.stderr.join(''), /xxxxxxxx|uncaught|node:internal/i);
  } finally {
    await session.cleanup();
  }
});

serveTest('stdio client gate scans decoded request and response values for credentials', async (t) => {
  const sensitiveProperties = [
    'token',
    'session_token',
    'oauth_token',
    'openAIAPIKey',
    'openai_api_key',
    'aws_secret_access_key',
    'token_value',
    'sessionTokenValue',
    'githubTokenValue',
    'openAIKey',
    'AWSAccessKeyId',
    'aws_access_key_id',
    'accessKeyId',
    'sessionTokenRaw',
    'oauthTokenRaw',
    'githubTokenRaw',
    'tokenPayload',
    'openAIKeyValue',
    'awsAccessKeyIdValue',
  ];
  const credentialValues = [
    ['Basic authorization', 'basic-auth', 'Basic c3ludGhldGljOnBhc3M=', /c3ludGhldGljOnBhc3M/],
    ['short Basic authorization', 'basic-auth-short', 'Basic dTpw', /dTpw/],
    ['unpadded Basic authorization', 'basic-auth-unpadded', 'Basic dTpwZA', /dTpwZA/],
    ['over-padded Basic authorization', 'basic-auth-overpadded', 'Basic dTpw=', /dTpw/],
    ['multiply over-padded Basic authorization', 'basic-auth-multiply-overpadded', 'Basic dTpw===', /dTpw/],
    ...ECMASCRIPT_WHITESPACE_CHARACTERS.map((whitespace) => {
      const codePoint = whitespace.codePointAt(0).toString(16).padStart(4, '0');
      return [
        `ECMAScript U+${codePoint.toUpperCase()}-folded Basic authorization`,
        `basic-auth-whitespace-u${codePoint}`,
        `Basic dT${whitespace}pw`,
        /dT/,
      ];
    }),
    ['leading-dot Basic authorization', 'basic-auth-leading-dot', '.Basic dTpw', /\.Basic dTpw/],
    ['leading-dash Basic authorization', 'basic-auth-leading-dash', '-Basic dTpw', /-Basic dTpw/],
    ['leading-underscore Basic authorization', 'basic-auth-leading-underscore', '_Basic dTpw', /_Basic dTpw/],
    ['path-component Basic authorization', 'basic-auth-path-component', '/.-_Basic dTpw/', /\.\-_Basic dTpw/],
    [
      'base64url Basic authorization',
      'basic-auth-base64url',
      'Basic ZiA0dD86O30_MX4',
      /ZiA0dD86O30_MX4/,
    ],
    ['dangling-alphanumeric Basic authorization', 'basic-auth-dangling-alphanumeric', 'Basic dTpwA', /dTpwA/],
    ['dangling-dash Basic authorization', 'basic-auth-dangling-dash', 'Basic dTpw-', /dTpw-/],
    ['dangling-underscore Basic authorization', 'basic-auth-dangling-underscore', 'Basic dTpw_', /dTpw_/],
    ['ignored-dot Basic authorization', 'basic-auth-ignored-dot', 'Basic dTpw.', /dTpw\./],
    ['ignored-tilde Basic authorization', 'basic-auth-ignored-tilde', 'Basic dTpw~', /dTpw~/],
    ['punctuation-wrapped Basic authorization', 'basic-auth-wrapped', '(Basic dTpw)', /dTpw/],
    [
      'Proxy-Authorization header',
      'proxy-authorization',
      'Proxy-Authorization: Basic c3ludGhldGljOnBhc3M=',
      /c3ludGhldGljOnBhc3M/,
    ],
    [
      'separated Proxy-Authorization pair',
      'proxy-authorization-pair',
      ['Proxy-Authorization', 'Negotiate synthetic-negotiate-token'],
      /synthetic-negotiate-token/,
    ],
    [
      'separated Authorization pair with a short Bearer value',
      'authorization-short-bearer',
      ['Authorization', 'Bearer x'],
      /Bearer x/,
    ],
    [
      'separated Authorization pair with a non-Basic value',
      'authorization-non-basic',
      ['Authorization', 'Negotiate x'],
      /Negotiate x/,
    ],
    [
      'URL userinfo',
      'url-userinfo',
      'https://synthetic-user:synthetic-pass@example.test/path',
      /synthetic-user|synthetic-pass/,
    ],
  ];
  await t.test('decoded client request', async () => {
    const session = await startGate('client-gateway-good.js');
    try {
      session.child.stdin.write(
        '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"risk_fork_protect","arguments":{"operation":"Bearer\\u0020synthetic1234"}}}\n',
      );
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null, 'decoded request rejection must terminate promptly');
      assert.equal(outcome.code, 78);
      assert.doesNotMatch(session.stderr.join(''), /synthetic1234|uncaught|node:internal/i);
    } finally {
      await session.cleanup();
    }
  });

  await t.test('decoded control-whitespace request', async () => {
    const session = await startGate('client-gateway-good.js');
    try {
      session.child.stdin.write(
        '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"risk_fork_protect","arguments":{"operation":"Bearer\\nsynthetic1234"}}}\n',
      );
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null, 'decoded control whitespace must terminate promptly');
      assert.equal(outcome.code, 78);
      assert.doesNotMatch(session.stderr.join(''), /synthetic1234|uncaught|node:internal/i);
    } finally {
      await session.cleanup();
    }
  });

  await t.test('decoded gateway response', async () => {
    const session = await startGate('client-gateway-escaped-secret.js');
    try {
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'risk_fork_protect',
          arguments: { operation: 'ordinary' },
        },
      })}\n`);
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null, 'decoded response rejection must terminate promptly');
      assert.equal(outcome.code, 78);
      assert.doesNotMatch(session.stderr.join(''), /synthetic1234|uncaught|node:internal/i);
    } finally {
      await session.cleanup();
    }
  });

  for (const [name, , value, forbiddenOutput] of credentialValues) {
    await t.test(`neutral client value containing ${name}`, async () => {
      const session = await startGate('client-gateway-good.js');
      try {
        session.child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
            name: 'risk_fork_protect',
            arguments: { operation: 'ordinary', metadata: { note: value } },
          },
        })}\n`);
        const outcome = await withTimeout(session.exit, 2_000);
        assert.notEqual(outcome, null, `${name} request must terminate promptly`);
        assert.equal(outcome.code, 78);
        assert.doesNotMatch(session.stderr.join(''), forbiddenOutput);
        assert.doesNotMatch(JSON.stringify(session.messages), forbiddenOutput);
      } finally {
        await session.cleanup();
      }
    });
  }

  for (const [name, operation, , forbiddenOutput] of credentialValues) {
    await t.test(`neutral gateway value containing ${name}`, async () => {
      const session = await startGate('client-gateway-hostile-responses.js');
      try {
        session.child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
            name: 'risk_fork_protect', arguments: { operation },
          },
        })}\n`);
        const outcome = await withTimeout(session.exit, 2_000);
        assert.notEqual(outcome, null, `${name} response must terminate promptly`);
        assert.equal(outcome.code, 78);
        assert.doesNotMatch(session.stderr.join(''), forbiddenOutput);
        assert.doesNotMatch(JSON.stringify(session.messages), forbiddenOutput);
      } finally {
        await session.cleanup();
      }
    });
  }

  for (const property of sensitiveProperties) {
    await t.test(`sensitive client property ${property}`, async () => {
      const session = await startGate('client-gateway-good.js');
      try {
        session.child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'risk_fork_protect',
            arguments: { operation: 'ordinary', [property]: 'abcdefgh' },
          },
        })}\n`);
        const outcome = await withTimeout(session.exit, 2_000);
        assert.notEqual(outcome, null, 'sensitive request property must terminate promptly');
        assert.equal(outcome.code, 78);
        assert.doesNotMatch(session.stderr.join(''), /abcdefgh|uncaught|node:internal/i);
      } finally {
        await session.cleanup();
      }
    });
  }

  await t.test('ordinary token metadata names remain available', async () => {
    const session = await startGate('client-gateway-good.js');
    try {
      const called = await session.request(1, 'tools/call', {
        name: 'risk_fork_protect',
        arguments: {
          operation: 'ordinary-metadata',
          token_count: 12,
          tokenizer: 'fixture',
          api_keynote: 'fixture',
          description: 'run a basic test',
        },
      });
      assert.equal(called.error, undefined);
    } finally {
      await session.cleanup();
    }
  });

  for (const [index, property] of sensitiveProperties.entries()) {
    await t.test(`sensitive gateway property ${property}`, async () => {
      const session = await startGate('client-gateway-hostile-responses.js');
      try {
        session.child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
            name: 'risk_fork_protect', arguments: { operation: `sensitive-field-${index}` },
          },
        })}\n`);
        const outcome = await withTimeout(session.exit, 2_000);
        assert.notEqual(outcome, null, 'sensitive response property must terminate promptly');
        assert.equal(outcome.code, 78);
        assert.doesNotMatch(session.stderr.join(''), /abcdefgh|uncaught|node:internal/i);
      } finally {
        await session.cleanup();
      }
    });
  }
});

serveTest('stdio client gate rejects numbers that JSON cannot round-trip canonically', async (t) => {
  const nonCanonicalNumbers = [
    ['non-finite number', '1e400', 'non-finite-number'],
    ['negative zero', '-0', 'negative-zero'],
    ['unsafe integer', '9007199254740993', 'unsafe-integer'],
    ['underflow number', '1e-400', 'underflow-number'],
    ['rounded number below one', '0.99999999999999999', 'rounded-below-one'],
    ['rounded decimal tail', '0.100000000000000005', 'rounded-decimal-tail'],
  ];
  const canonicalEquivalentNumbers = [
    ['equivalent decimal', '1.0', 'equivalent-decimal', 1],
    ['equivalent exponent', '1e3', 'equivalent-exponent', 1000],
  ];
  for (const [name, literal] of nonCanonicalNumbers) {
    await t.test(`client request ${name}`, async () => {
      const session = await startGate('client-gateway-good.js');
      try {
        session.child.stdin.write(
          `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"risk_fork_protect","arguments":{"operation":"ordinary","numeric_value":${literal}}}}\n`,
        );
        const outcome = await withTimeout(session.exit, 2_000);
        assert.notEqual(outcome, null, `${name} request must terminate promptly`);
        assert.equal(outcome.code, 78);
        assert.doesNotMatch(session.stderr.join(''), /uncaught|node:internal/i);
      } finally {
        await session.cleanup();
      }
    });
  }

  await t.test('ordinary finite safe numbers remain available', async () => {
    const session = await startGate('client-gateway-good.js');
    try {
      const called = await session.request(1, 'tools/call', {
        name: 'risk_fork_protect',
        arguments: {
          operation: 'ordinary-numbers',
          numeric_values: [0, 1.5, Number.MAX_SAFE_INTEGER],
        },
      });
      assert.equal(called.error, undefined);
    } finally {
      await session.cleanup();
    }
  });

  for (const [name, literal] of canonicalEquivalentNumbers) {
    await t.test(`client request ${name}`, async () => {
      const session = await startGate('client-gateway-good.js');
      try {
        session.child.stdin.write(
          `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"risk_fork_protect","arguments":{"operation":"ordinary","numeric_value":${literal}}}}\n`,
        );
        const barrier = await session.request(2, 'tools/call', {
          name: 'risk_fork_protect', arguments: { operation: 'ordinary' },
        });
        assert.equal(barrier.error, undefined);
        assert.equal(
          session.messages.filter((message) => message.id === 1 && message.error === undefined).length,
          1,
        );
      } finally {
        await session.cleanup();
      }
    });
  }

  await t.test('many raw equivalent numbers remain linearly bounded', async () => {
    const session = await startGate('client-gateway-good.js');
    try {
      const repeatedNumber = `1.${'0'.repeat(120)}`;
      const rawLine = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"risk_fork_protect","arguments":{"operation":"ordinary","numeric_values":[${Array(6_000).fill(repeatedNumber).join(',')}]}}}\n`;
      assert.ok(Buffer.byteLength(rawLine) < 1024 * 1024);
      session.child.stdin.write(rawLine);
      const barrier = await session.request(2, 'tools/call', {
        name: 'risk_fork_protect', arguments: { operation: 'ordinary' },
      });
      assert.equal(barrier.error, undefined);
      assert.equal(
        session.messages.filter((message) => message.id === 1 && message.error === undefined).length,
        1,
      );
    } finally {
      await session.cleanup();
    }
  });

  for (const [name, , operation] of nonCanonicalNumbers) {
    await t.test(`gateway response ${name}`, async () => {
      const session = await startGate('client-gateway-hostile-responses.js');
      try {
        session.child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
            name: 'risk_fork_protect', arguments: { operation },
          },
        })}\n`);
        const outcome = await withTimeout(session.exit, 2_000);
        assert.notEqual(outcome, null, `${name} response must terminate promptly`);
        assert.equal(outcome.code, 78);
        assert.doesNotMatch(session.stderr.join(''), /uncaught|node:internal/i);
      } finally {
        await session.cleanup();
      }
    });
  }

  for (const [name, , operation, expected] of canonicalEquivalentNumbers) {
    await t.test(`gateway response ${name}`, async () => {
      const session = await startGate('client-gateway-hostile-responses.js');
      try {
        const called = await session.request(1, 'tools/call', {
          name: 'risk_fork_protect', arguments: { operation },
        });
        assert.equal(called.error, undefined);
        assert.equal(called.result.value, expected);
      } finally {
        await session.cleanup();
      }
    });
  }
});

serveTest('stdio client gate requires fatal UTF-8 decoding and preserves BOM framing', async (t) => {
  await t.test('malformed client bytes fail closed', async () => {
    const session = await startGate('client-gateway-good.js');
    try {
      session.child.stdin.write(Buffer.concat([
        Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"risk_fork_protect","arguments":{"operation":"'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('"}}}\n'),
      ]));
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null, 'malformed client UTF-8 must terminate promptly');
      assert.equal(outcome.code, 78);
      assert.doesNotMatch(session.stderr.join(''), /\uFFFD|uncaught|node:internal/i);
    } finally {
      await session.cleanup();
    }
  });

  await t.test('malformed gateway bytes fail closed', async () => {
    const session = await startGate('client-gateway-hostile-responses.js');
    try {
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'risk_fork_protect', arguments: { operation: 'malformed-utf8' },
        },
      })}\n`);
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null, 'malformed gateway UTF-8 must terminate promptly');
      assert.equal(outcome.code, 78);
      assert.doesNotMatch(session.stderr.join(''), /\uFFFD|uncaught|node:internal/i);
    } finally {
      await session.cleanup();
    }
  });

  await t.test('leading client BOM remains an invalid JSON frame', async () => {
    const session = await startGate('client-gateway-good.js');
    try {
      session.child.stdin.write(Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(`${JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
            name: 'risk_fork_protect', arguments: { operation: 'ordinary' },
          },
        })}\n`),
      ]));
      const barrier = await session.request(2, 'tools/call', {
        name: 'risk_fork_protect', arguments: { operation: 'ordinary' },
      });
      assert.equal(barrier.error, undefined);
      assert.equal(
        session.messages.some((message) => message.id === null && message.error?.code === -32700),
        true,
      );
    } finally {
      await session.cleanup();
    }
  });

  await t.test('leading gateway BOM remains an invalid JSON frame', async () => {
    const session = await startGate('client-gateway-hostile-responses.js');
    try {
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'risk_fork_protect', arguments: { operation: 'leading-bom' },
        },
      })}\n`);
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null, 'gateway BOM must terminate promptly');
      assert.equal(outcome.code, 78);
      assert.doesNotMatch(session.stderr.join(''), /uncaught|node:internal/i);
    } finally {
      await session.cleanup();
    }
  });
});

serveTest('stdio client gate bounds decoded JSON depth in both directions', async (t) => {
  const deepValue = `${'['.repeat(10_000)}0${']'.repeat(10_000)}`;
  await t.test('deep client request', async () => {
    const session = await startGate('client-gateway-good.js');
    try {
      session.child.stdin.write(
        `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"risk_fork_protect","arguments":{"operation":${deepValue}}}}\n`,
      );
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null, 'deep request rejection must terminate promptly');
      assert.equal(outcome.code, 78);
      assert.doesNotMatch(session.stderr.join(''), /RangeError|call stack|uncaught|node:internal/i);
    } finally {
      await session.cleanup();
    }
  });

  await t.test('deep gateway response', async () => {
    const session = await startGate('client-gateway-hostile-responses.js');
    try {
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'risk_fork_protect', arguments: { operation: 'deep' },
        },
      })}\n`);
      const outcome = await withTimeout(session.exit, 2_000);
      assert.notEqual(outcome, null, 'deep response rejection must terminate promptly');
      assert.equal(outcome.code, 78);
      assert.doesNotMatch(session.stderr.join(''), /RangeError|call stack|uncaught|node:internal/i);
    } finally {
      await session.cleanup();
    }
  });
});

test('stdio client gate force-exits while client output remains blocked', {
  skip: process.platform === 'win32' ? 'POSIX pipe backpressure boundary' : false,
}, async () => {
  const session = await startGate('client-gateway-hostile-responses.js', { consumeOutput: false });
  try {
    session.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'risk_fork_protect', arguments: { operation: 'large' },
      },
    })}\n`);
    const outcome = await withTimeout(session.exit, 2_500);
    assert.notEqual(outcome, null, 'blocked client output must not keep the gate alive');
    assert.equal(outcome.code, 78);
    assert.doesNotMatch(session.stderr.join(''), /uncaught|node:internal/i);
  } finally {
    await session.cleanup();
  }
});

serveTest('stdio client gate force-terminates a gateway that ignores graceful shutdown', async () => {
  const session = await startGate('client-gateway-ignores-termination.js', { ready: false });
  try {
    const started = Date.now();
    const outcome = await withTimeout(session.exit, 2_500);
    assert.notEqual(outcome, null, 'stubborn gateway shutdown must remain bounded');
    assert.equal(outcome.code, 78);
    assert.ok(Date.now() - started < 2_500);
    assert.doesNotMatch(session.stderr.join(''), /uncaught|node:internal/i);
  } finally {
    await session.cleanup();
  }
});

serveTest('stdio client gate exits promptly when verified gateway compilation throws', async () => {
  const session = await startGate('client-gateway-compile-throws.js', { ready: false });
  try {
    const outcome = await withTimeout(session.exit, 2_000);
    assert.notEqual(outcome, null, 'gateway compile failure must terminate promptly');
    assert.deepEqual(outcome, { code: 78, signal: null });
    assert.doesNotMatch(session.stderr.join(''), /synthetic compile failure|uncaught|node:internal/i);
  } finally {
    await session.cleanup();
  }
});

serveTest('stdio client gate cleans stubborn descendants after hostile gateway compilation throws', async () => {
  const session = await startGate('client-gateway-compile-throws-with-descendant.js', { ready: false });
  let descendantPid = null;
  try {
    const pidFile = path.join(session.temporaryRoot, 'compile-descendant.pid');
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        descendantPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
        break;
      } catch {
        await delay(10);
      }
    }
    assert.equal(Number.isSafeInteger(descendantPid), true, 'compile descendant pid must be recorded');
    const outcome = await withTimeout(session.exit, 2_500);
    assert.notEqual(outcome, null, 'hostile compile failure cleanup must remain bounded');
    assert.deepEqual(outcome, { code: 78, signal: null });
    await delay(100);
    assert.equal(await isProcessExecutable(descendantPid), false, 'compile descendant must not remain executable');
    assert.doesNotMatch(
      session.stderr.join(''),
      /synthetic compile failure|synthetic descendant readiness failure|uncaught|node:internal/i,
    );
  } finally {
    if (Number.isSafeInteger(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch {}
    }
    await session.cleanup();
  }
});

test('stdio client gate terminates the POSIX process group after its leader exits', {
  skip: process.platform === 'win32' ? 'POSIX process-group boundary' : false,
}, async () => {
  const session = await startGate('client-gateway-descendant.js', { ready: false });
  let descendantPid = null;
  try {
    const pidFile = path.join(session.temporaryRoot, 'descendant.pid');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        descendantPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
        break;
      } catch {
        await delay(10);
      }
    }
    assert.equal(Number.isSafeInteger(descendantPid), true, 'descendant pid must be recorded');
    const outcome = await withTimeout(session.exit, 2_500);
    assert.notEqual(outcome, null, 'descendant cleanup must remain bounded');
    assert.equal(outcome.code, 78);
    await delay(100);
    assert.equal(await isProcessExecutable(descendantPid), false, 'descendant must not remain executable');
  } finally {
    if (Number.isSafeInteger(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch {}
    }
    await session.cleanup();
  }
});

test('stdio client gate routes SIGHUP through bounded POSIX gateway cleanup', {
  skip: process.platform === 'win32' ? 'POSIX SIGHUP process-group boundary' : false,
}, async () => {
  const session = await startGate('client-gateway-start-marker.js', { ready: false });
  let gatewayPid = null;
  try {
    const pidFile = path.join(session.temporaryRoot, 'gateway.pid');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        gatewayPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
        break;
      } catch {
        await delay(10);
      }
    }
    assert.equal(Number.isSafeInteger(gatewayPid), true, 'gateway pid must be recorded');
    session.child.kill('SIGHUP');
    await delay(25);
    session.child.kill('SIGHUP');
    const outcome = await withTimeout(session.exit, 2_500);
    assert.notEqual(outcome, null, 'SIGHUP cleanup must remain bounded');
    assert.deepEqual(outcome, { code: 0, signal: null });
    await delay(100);
    assert.equal(await isProcessExecutable(gatewayPid), false, 'gateway must not remain executable');
    assert.doesNotMatch(session.stderr.join(''), /uncaught|node:internal/i);
  } finally {
    if (Number.isSafeInteger(gatewayPid)) {
      try { process.kill(gatewayPid, 'SIGKILL'); } catch {}
    }
    await session.cleanup();
  }
});

test('stdio client gate rejects serialized gateway paths containing full credential forms', () => {
  const unsafePaths = [
    path.join(path.parse(packageRoot).root, 'synthetic', 'Basic dTpw', 'risk-forkd.js'),
    path.join(path.parse(packageRoot).root, 'synthetic', 'Basic dTpw===', 'risk-forkd.js'),
    path.join(path.parse(packageRoot).root, 'synthetic', 'Basic dT pw', 'risk-forkd.js'),
    path.join(path.parse(packageRoot).root, 'synthetic', 'Basic ZiA0dD86O30_MX4', 'risk-forkd.js'),
    path.join(path.parse(packageRoot).root, 'synthetic', 'Basic dTpwA', 'risk-forkd.js'),
    path.join(path.parse(packageRoot).root, 'synthetic', 'Basic dTpw-', 'risk-forkd.js'),
    path.join(path.parse(packageRoot).root, 'synthetic', 'Basic dTpw_', 'risk-forkd.js'),
    path.join(path.parse(packageRoot).root, 'synthetic', 'Basic dTpw.', 'risk-forkd.js'),
    path.join(path.parse(packageRoot).root, 'synthetic', 'Basic dTpw~', 'risk-forkd.js'),
    path.join(path.parse(packageRoot).root, 'synthetic', '(Basic dTpw)', 'risk-forkd.js'),
    path.join(path.parse(packageRoot).root, 'synthetic', '.Basic dTpw', 'risk-forkd.js'),
    path.join(path.parse(packageRoot).root, 'synthetic', '-Basic dTpw', 'risk-forkd.js'),
    path.join(path.parse(packageRoot).root, 'synthetic', '_Basic dTpw', 'risk-forkd.js'),
    path.join(path.parse(packageRoot).root, 'synthetic', '.-_Basic dTpw', 'risk-forkd.js'),
    path.join(
      path.parse(packageRoot).root,
      'synthetic',
      'synthetic-user:synthetic-pass@example.test',
      'risk-forkd.js',
    ),
  ];
  for (const gateway of unsafePaths) {
    const refused = spawnSync(process.execPath, [
      gateEntrypoint,
      'serve',
      '--gateway-entrypoint', gateway,
      '--gateway-sha256', `sha256:${'0'.repeat(64)}`,
    ], { cwd: packageRoot, encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.equal(refused.status, 78);
    assert.equal(refused.stdout, '');
    assert.match(JSON.parse(refused.stderr).message, /absolute path ending in risk-forkd\.js/);
    assert.doesNotMatch(refused.stderr, /dTpw|synthetic-user|synthetic-pass/);
  }
});

test('credential scanning remains bounded for a near-limit repeated Basic prefix', () => {
  const probe = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { containsSerializedCredentialMaterial } from ${JSON.stringify(utilEntrypointUrl)};
const adversarial = 'basic '.repeat(174_762) + '!';
if (containsSerializedCredentialMaterial(adversarial) !== false) process.exit(2);
const folded = 'Basic dT' + '\\f'.repeat(1_000_000) + 'pw';
if (containsSerializedCredentialMaterial(folded) !== true) process.exit(3);`,
  ], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 2_500,
    windowsHide: true,
  });
  assert.equal(probe.error?.code, undefined, 'credential scan exceeded its bounded runtime');
  assert.equal(probe.status, 0, probe.stderr);
});

test('credential scanning recognizes punctuation boundaries without matching embedded identifiers', () => {
  for (const wrapped of [
    '(Basic dTpw)',
    '[Basic dTpw]',
    '"Basic dTpw"',
    ',Basic dTpw',
    ';Basic dTpw',
    '.Basic dTpw',
    '-Basic dTpw',
    '_Basic dTpw',
    '/.Basic dTpw/',
    '/-_Basic dTpw/',
  ]) {
    assert.equal(containsSerializedCredentialMaterial(wrapped), true);
  }
  assert.equal(containsSerializedCredentialMaterial('nonbasic dTpw'), false);
  assert.equal(containsSerializedCredentialMaterial('non-basic dTpw'), false);
  assert.equal(containsSerializedCredentialMaterial('non.basic dTpw'), false);
  assert.equal(containsSerializedCredentialMaterial('non_basic dTpw'), false);
  assert.equal(containsSerializedCredentialMaterial('non.-_Basic dTpw'), false);
});

test('credential scanning consumes and removes the same complete whitespace set', () => {
  const runtimeWhitespaceCharacters = [];
  const whitespacePattern = /\s/u;
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    const character = String.fromCodePoint(codePoint);
    if (whitespacePattern.test(character)) runtimeWhitespaceCharacters.push(character);
  }
  assert.deepEqual(runtimeWhitespaceCharacters, ECMASCRIPT_WHITESPACE_CHARACTERS);

  for (const whitespace of ECMASCRIPT_WHITESPACE_CHARACTERS) {
    assert.equal(containsSerializedCredentialMaterial(`Basic${whitespace}dTpw`), true);
    assert.equal(containsSerializedCredentialMaterial(`Basic d${whitespace}Tpw`), true);
    assert.equal(containsSerializedCredentialMaterial(`Basic dT${whitespace}pw`), true);
    assert.equal(containsSerializedCredentialMaterial(`Basic dTp${whitespace}w`), true);
  }
});

serveTest('stdio client gate bounds descriptor reads while the gateway file changes size', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'risk-fork-client-gate-size-race-'));
  const gateway = path.join(temporaryRoot, 'risk-forkd.js');
  const source = await readFile(path.join(fixtureRoot, 'client-gateway-good.js'));
  const padded = Buffer.concat([source, Buffer.from(`\n/*${'x'.repeat(256_000)}*/\n`)]);
  const expectedHash = `sha256:${createHash('sha256').update(padded).digest('hex')}`;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await writeFile(gateway, padded);
      const child = spawn(process.execPath, [
        gateEntrypoint, 'serve', '--gateway-entrypoint', gateway,
        '--gateway-sha256', expectedHash,
      ], { cwd: packageRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const stderr = [];
      child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
      const exited = new Promise((resolve) => child.once('close', (code) => resolve(code)));
      const racing = (async () => {
        for (let change = 0; change < 8; change += 1) {
          await truncate(gateway, RISK_FORK_CLIENT_GATE_MAX_GATEWAY_BYTES + 1);
          await truncate(gateway, padded.length);
        }
      })();
      child.stdin.end();
      const code = await withTimeout(exited, 5_000);
      await racing;
      assert.notEqual(code, null, `size-race attempt ${attempt + 1} must terminate`);
      assert.ok(code === 0 || code === 78, `size-race attempt ${attempt + 1}`);
      assert.doesNotMatch(stderr.join(''), /RangeError|allocation failed|heap out of memory|uncaught/i);
    }
    const gateSource = await readFile(gateEntrypoint, 'utf8');
    assert.match(gateSource, /Buffer\.alloc\(details\.size\)/);
    assert.doesNotMatch(gateSource, /readFileSync\(descriptor\)/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('stdio client gate rejects a FIFO gateway without blocking', {
  skip: process.platform === 'win32' ? 'POSIX FIFO boundary' : false,
}, async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'risk-fork-client-gate-fifo-'));
  try {
    const gateway = path.join(temporaryRoot, 'risk-forkd.js');
    const created = spawnSync('mkfifo', [gateway], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    const child = spawn(process.execPath, [
      gateEntrypoint,
      'serve',
      '--gateway-entrypoint',
      gateway,
      '--gateway-sha256',
      `sha256:${'0'.repeat(64)}`,
    ], { cwd: packageRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
    child.stdin.end();
    const exit = new Promise((resolve) => child.once('close', (code) => resolve(code)));
    const code = await withTimeout(exit, 1_500);
    assert.notEqual(code, null, 'FIFO verification must not wait for a writer');
    assert.equal(code, 78);
    assert.match(stderr.join(''), /regular file/);
    const [gateSource, plannerSource] = await Promise.all([
      readFile(gateEntrypoint, 'utf8'),
      readFile(path.join(packageRoot, 'scripts', 'client-adoption.mjs'), 'utf8'),
    ]);
    assert.match(gateSource, /O_NONBLOCK/);
    assert.match(plannerSource, /O_NONBLOCK/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

serveTest('stdio client gate never executes gateway bytes swapped after launch begins', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'risk-fork-client-gate-race-'));
  const gateway = path.join(temporaryRoot, 'risk-forkd.js');
  const verifiedBytes = await readFile(path.join(fixtureRoot, 'client-gateway-good.js'));
  const expectedHash = `sha256:${createHash('sha256').update(verifiedBytes).digest('hex')}`;
  const alteredBytes = Buffer.from(
    "'use strict'; process.stderr.write('ALTERED_GATEWAY_EXECUTED'); process.exit(66);\n",
    'utf8',
  );
  try {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await writeFile(gateway, verifiedBytes);
      const stderr = [];
      const child = spawn(process.execPath, [
        gateEntrypoint,
        'serve',
        '--gateway-entrypoint', gateway,
        '--gateway-sha256', expectedHash,
      ], {
        cwd: packageRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const exited = new Promise((resolve) => {
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
      await writeFile(gateway, alteredBytes);
      child.stdin.end();
      const outcome = await withTimeout(exited, 5_000);
      if (outcome === null) {
        child.kill();
        await exited;
        assert.fail(`gateway race attempt ${attempt + 1} timed out`);
      }
      assert.notEqual(outcome.code, 66, `attempt ${attempt + 1}`);
      assert.doesNotMatch(stderr.join(''), /ALTERED_GATEWAY_EXECUTED/, `attempt ${attempt + 1}`);
      assert.ok(outcome.code === 0 || outcome.code === 78, `attempt ${attempt + 1}`);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
