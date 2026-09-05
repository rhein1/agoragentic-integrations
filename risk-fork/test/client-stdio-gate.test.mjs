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

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = path.dirname(packageRoot);
const gateEntrypoint = path.join(packageRoot, 'clients', 'one-tool-stdio-gate.mjs');
const fixtureRoot = path.join(packageRoot, 'test', 'fixtures');

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

async function startGate(fixtureName, { consumeOutput = true } = {}) {
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
  const stderr = [];
  const output = consumeOutput ? createInterface({ input: child.stdout }) : null;
  const exit = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  if (output) {
    output.on('line', (line) => {
      const message = JSON.parse(line);
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
  return { child, cleanup, exit, gateway, request, stderr, temporaryRoot };
}

test('stdio client gate exposes and forwards only risk_fork_protect', async () => {
  const session = await startGate('client-gateway-good.js');
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

test('stdio client gate fails closed when a gateway advertises any second tool', async () => {
  const session = await startGate('client-gateway-extra-tool.js');
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

test('stdio client gate rejects gateway-to-client requests even when they reuse a pending id', async () => {
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

test('stdio client gate bounds concurrent pending gateway requests', async () => {
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

test('stdio client gate leaves the exact schema to the gateway but requires an object input', async () => {
  const session = await startGate('client-gateway-invalid-schema.js');
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

test('stdio client gate verifies exact gateway bytes and current gateway stays unavailable', async () => {
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
    credentials_forwarded: false,
    provider_calls: 0,
    network_implementation_included: false,
  });

  const source = await readFile(gateEntrypoint, 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|https?\.request|connectRemoteClient|commitPrepared)\b/);
  assert.doesNotMatch(source, /from ['"](?:node:)?(?:dns|http|https|net|tls|undici)['"]/);
});

test('stdio client gate preserves a clean exit after client EOF', async () => {
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

test('stdio client gate fails closed when the gateway response stream ends early', {
  skip: process.platform === 'win32' ? 'POSIX response-stream EOF boundary' : false,
}, async (t) => {
  await t.test('idle gateway', async () => {
    const session = await startGate('client-gateway-closes-output.js');
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
    const session = await startGate('client-gateway-closes-output.js');
    try {
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
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

test('stdio client gate contains closed and backpressured gateway pipe errors', async (t) => {
  await t.test('closed child input', async () => {
    const session = await startGate('client-gateway-closed-input.js');
    try {
      await delay(100);
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'risk_fork_protect',
          arguments: { operation: 'closed-'.repeat(25_000) },
        },
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
    const session = await startGate('client-gateway-no-input-read.js');
    try {
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'risk_fork_protect',
          arguments: { operation: 'x'.repeat(900_000) },
        },
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

test('stdio client gate scans decoded request and response values for credentials', async (t) => {
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

  await t.test('sensitive client property', async () => {
    const session = await startGate('client-gateway-good.js');
    try {
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'risk_fork_protect',
          arguments: { operation: 'ordinary', access_token: 'abcdefgh' },
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

  await t.test('sensitive gateway property', async () => {
    const session = await startGate('client-gateway-hostile-responses.js');
    try {
      session.child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'risk_fork_protect', arguments: { operation: 'sensitive-field' },
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
});

test('stdio client gate bounds decoded JSON depth in both directions', async (t) => {
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

test('stdio client gate force-terminates a gateway that ignores graceful shutdown', async () => {
  const session = await startGate('client-gateway-ignores-termination.js');
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

test('stdio client gate terminates the POSIX process group after its leader exits', {
  skip: process.platform === 'win32' ? 'POSIX process-group boundary' : false,
}, async () => {
  const session = await startGate('client-gateway-descendant.js');
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
    let descendantRunning = true;
    try {
      process.kill(descendantPid, 0);
      if (process.platform === 'linux') {
        const processStat = await readFile(`/proc/${descendantPid}/stat`, 'utf8');
        descendantRunning = !/^\d+ \(.*\) Z /.test(processStat);
      }
    } catch (error) {
      if (error?.code === 'ESRCH' || error?.code === 'ENOENT') descendantRunning = false;
      else throw error;
    }
    assert.equal(descendantRunning, false, 'descendant must not remain executable');
  } finally {
    if (Number.isSafeInteger(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch {}
    }
    await session.cleanup();
  }
});

test('stdio client gate bounds descriptor reads while the gateway file changes size', async () => {
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

test('stdio client gate never executes gateway bytes swapped after launch begins', async () => {
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
