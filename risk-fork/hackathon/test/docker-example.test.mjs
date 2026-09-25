import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  cleanupDockerExample,
  dockerCommandForEnvironment,
  dockerRunArgs,
  preflightDockerExample,
  runDockerExample,
} from '../docker-example/runner.mjs';

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const CONTAINER_ID = 'b'.repeat(64);
const NONCE = 'c'.repeat(32);
const NAME = `rf-local-mcp-${NONCE}`;
const LABEL = 'agoragentic.risk-fork.local-docker-example.nonce';

function success(stdout) { return { ok: true, stdout, stderr: '' }; }

function makeDocker({ endpoint = 'npipe:////./pipe/docker_engine', os = 'linux',
  imageEnvironment = ['PATH=/usr/local/bin', 'NODE_VERSION=22.0.0', 'YARN_VERSION=1.0.0'],
  imageVolumes = null, containerState = 'absent', ownerNonce = NONCE } = {}) {
  const calls = [];
  const boundCalls = [];
  let state = containerState;
  const execDocker = async (args) => {
    const command = [...args];
    let config = null;
    let host = null;
    while (['--config', '--host'].includes(command[0])) {
      const flag = command.shift();
      const value = command.shift();
      if (flag === '--config') config = value;
      else host = value;
    }
    calls.push(command);
    boundCalls.push({ command, config, host });
    const key = command.slice(0, 2).join(' ');
    if (key === 'context show') return success('desktop-linux\n');
    if (key === 'context inspect') return success(`${JSON.stringify(endpoint)}\n`);
    if (key === 'info --format') return success(`${os}\n`);
    if (key === 'image inspect') return success(JSON.stringify({
      Id: IMAGE_ID, Os: 'linux', RepoTags: ['node:22-alpine'],
      Config: { Env: imageEnvironment, Volumes: imageVolumes, Healthcheck: null },
    }));
    if (key === 'container inspect') {
      if (state === 'absent') return {
        ok: false, stdout: '', stderr: `Error: No such object: ${NAME}\n`,
      };
      if (state === 'daemon_error') return { ok: false, stdout: '', stderr: 'daemon unavailable' };
      return success(JSON.stringify({
        Id: CONTAINER_ID, Name: `/${NAME}`, Config: { Labels: { [LABEL]: ownerNonce } },
      }));
    }
    if (key === 'container rm') {
      assert.equal(command[3], CONTAINER_ID);
      state = 'absent';
      return success(`${CONTAINER_ID}\n`);
    }
    throw new Error(`Unexpected mocked Docker command: ${command.join(' ')}`);
  };
  return { execDocker, calls, boundCalls, setContainerState(value) { state = value; } };
}

function responseLines() {
  return [
    { jsonrpc: '2.0', id: 1, result: {
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'risk-fork-local-docker-synthetic', version: '1' },
    } },
    { jsonrpc: '2.0', id: 2, result: { tools: [{
      name: 'risk_fork_synthetic_untrusted_tool',
      description: 'SYNTHETIC UNTRUSTED MCP DESCRIPTION',
    }] } },
    { jsonrpc: '2.0', id: 3, result: { structuredContent: {
      schema: 'agoragentic.risk-fork.local-docker-example.v1',
      demo_only: true, provider_calls: 0, network_used: false,
      credentials_used: false, authority_granted: false,
      clean_commit_performed: false, e2b_qualified: false,
      live_traffic_protected: false, result: 'synthetic_untrusted_data',
    } } },
  ].map((value) => JSON.stringify(value)).join('\n') + '\n';
}

function fakeDockerChild({ exitCode = 0, output = responseLines(), closeOnInput = true } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  };
  const replies = output.trim().split('\n').map(JSON.parse);
  let pending = '';
  child.stdin.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const request = JSON.parse(line);
      if (Object.hasOwn(request, 'id')) {
        const reply = replies.find((value) => value.id === request.id);
        if (reply) queueMicrotask(() => child.stdout.write(`${JSON.stringify(reply)}\n`));
      }
    }
  });
  child.stdin.on('finish', () => {
    if (!closeOnInput) return;
    queueMicrotask(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', exitCode, null);
    });
  });
  return child;
}

test('standalone synthetic fixture speaks bounded MCP stdio without dependencies or Docker', async () => {
  const source = await readFile(new URL('../docker-example/synthetic-mcp.mjs', import.meta.url), 'utf8');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: { PATH: process.env.PATH ?? '' }, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exit = new Promise((resolve) => child.once('close', resolve));
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const responses = lines[Symbol.asyncIterator]();
  const diagnostics = [];
  child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  const initialized = JSON.parse((await responses.next()).value);
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  const listed = JSON.parse((await responses.next()).value);
  child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'risk_fork_synthetic_untrusted_tool', arguments: {},
    } })}\n`);
  const called = JSON.parse((await responses.next()).value);
  const code = await exit;
  lines.close();
  assert.equal(code, 0);
  assert.equal(Buffer.concat(diagnostics).length, 0);
  assert.match(listed.result.tools[0].description, /UNTRUSTED MCP DESCRIPTION/);
  assert.equal(called.result.structuredContent.provider_calls, 0);
  assert.equal(called.result.structuredContent.schema,
    'agoragentic.risk-fork.local-docker-example.v1');
  assert.equal(called.result.structuredContent.authority_granted, false);
});

test('synthetic MCP refuses tools before initialization acknowledgement', async () => {
  const source = await readFile(new URL('../docker-example/synthetic-mcp.mjs', import.meta.url), 'utf8');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: { PATH: process.env.PATH ?? '' }, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map((item) => JSON.stringify(item)).join('\n') + '\n');
  const code = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(code, 0);
  const responses = Buffer.concat(output).toString('utf8').trim().split('\n').map(JSON.parse);
  assert.equal(responses[0].id, 1);
  assert.equal(responses[1].id, 2);
  assert.equal(responses[1].error.code, -32000);
});

test('SIGINT ends the exact child, verifies owned cleanup, and removes signal handlers', async () => {
  const mock = makeDocker({ containerState: 'present' });
  const signals = new EventEmitter();
  let child;
  let handlersDuringCleanup = 0;
  const execute = async (args, environment) => {
    if (args.includes('container') && args.includes('inspect')) {
      handlersDuringCleanup = signals.listenerCount('SIGTERM');
      signals.emit('SIGTERM');
    }
    return mock.execDocker(args, environment);
  };
  await assert.rejects(runDockerExample({
    execDocker: execute, environment: {}, nonce: NONCE, signalEmitter: signals,
    spawnDocker() {
      child = fakeDockerChild({ closeOnInput: false });
      queueMicrotask(() => signals.emit('SIGINT'));
      return child;
    },
  }), (error) => error.code === 'DOCKER_RUN_INTERRUPTED'
    && error.cleanup === 'verified_absent');
  assert.ok(child);
  assert.equal(handlersDuringCleanup, 1);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(mock.calls.some((args) => args[0] === 'container' && args[1] === 'rm'), true);
});

test('Windows uses docker.exe or an explicit validated WSL distribution without a shell', () => {
  assert.deepEqual(dockerCommandForEnvironment({}, 'win32'), {
    binary: 'docker.exe', prefix: [],
  });
  const wsl = dockerCommandForEnvironment({ RISK_FORK_DOCKER_WSL_DISTRO: 'Ubuntu-24.04' }, 'win32');
  assert.equal(wsl.binary, 'wsl.exe');
  assert.deepEqual(wsl.prefix.slice(0, 4), ['-d', 'Ubuntu-24.04', '--exec', 'env']);
  assert.equal(wsl.prefix.at(-1), 'docker');
  assert.throws(() => dockerCommandForEnvironment({ RISK_FORK_DOCKER_WSL_DISTRO: 'bad;name' }, 'win32'),
    /DOCKER_WSL_DISTRO_INVALID/);
  assert.throws(() => dockerCommandForEnvironment({ RISK_FORK_DOCKER_WSL_DISTRO: 'Ubuntu-24.04' }, 'linux'),
    /DOCKER_WSL_DISTRO_INVALID/);
});

test('Docker arguments impose no pull, no network, no mounts or credentials, and no TTY', () => {
  const args = dockerRunArgs({ name: NAME, nonce: NONCE, source: 'fixture', imageId: IMAGE_ID });
  for (const required of ['--pull=never', '--rm', '-i', '--network=none', '--read-only',
    '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--pids-limit=32', '--memory=256m', '--cpus=0.5', '--no-healthcheck',
    '--entrypoint=node', IMAGE_ID]) {
    assert.ok(args.includes(required), required);
  }
  assert.equal(args.includes('-t'), false);
  assert.equal(args.some((arg) => /^(?:-e|--env|--mount|-v|--volume|-p|--publish|--privileged|--device|--use-api-socket)/u.test(arg)), false);
});

test('preflight fails before Docker run on remote endpoint, Windows engine, unsafe image, and missing image', async () => {
  for (const [options, code] of [
    [{ endpoint: 'tcp://remote.example:2375' }, 'REMOTE_DOCKER_ENDPOINT_BLOCKED'],
    [{ os: 'windows' }, 'LINUX_CONTAINER_ENGINE_REQUIRED'],
    [{ imageEnvironment: ['PATH=/usr/local/bin', 'E2B_API_KEY=not-a-real-key'] }, 'LOCAL_IMAGE_ENV_UNVERIFIED'],
    [{ imageVolumes: { '/data': {} } }, 'LOCAL_IMAGE_UNVERIFIED'],
  ]) {
    const mock = makeDocker(options);
    await assert.rejects(preflightDockerExample({ execDocker: mock.execDocker, environment: {} }),
      (error) => error.code === code);
  }
  const missing = makeDocker();
  const original = missing.execDocker;
  missing.execDocker = async (args, environment) => args.includes('image')
    ? { ok: false, stdout: '', stderr: 'No such image' }
    : original(args, environment);
  await assert.rejects(preflightDockerExample({ execDocker: missing.execDocker, environment: {} }),
    (error) => error.code === 'LOCAL_IMAGE_MISSING_NO_PULL');
  assert.equal(missing.calls.some((args) => args[0] === 'run'), false);
});

test('mocked local Docker probe verifies MCP and exact absent container', async () => {
  const mock = makeDocker();
  const runs = [];
  const result = await runDockerExample({
    execDocker: mock.execDocker, environment: {}, nonce: NONCE,
    spawnDocker(args) { runs.push(args); return fakeDockerChild(); },
  });
  assert.equal(runs.length, 1);
  assert.equal(result.status, 'verified_local_mcp_probe');
  assert.equal(result.cleanup, 'verified_absent');
  assert.equal(result.provider_calls, 0);
  assert.equal(result.e2b_qualified, false);
  assert.equal(mock.calls.some((args) => args[0] === 'container' && args[1] === 'inspect'), true);
  assert.equal(runs[0][0], '--config');
  assert.equal(runs[0][2], '--host');
  assert.equal(runs[0][3], 'npipe:////./pipe/docker_engine');
  assert.equal(mock.boundCalls.filter((call) => call.command[0] !== 'context')
    .every((call) => call.host === 'npipe:////./pipe/docker_engine'), true);
  assert.equal(mock.boundCalls.filter((call) => call.command[0] === 'container')
    .every((call) => call.config === runs[0][1]), true);
});

test('container launch uses an empty config and never inherits HOME proxy configuration', async () => {
  const mock = makeDocker();
  let observed = false;
  await runDockerExample({
    execDocker: mock.execDocker,
    environment: { HOME: '/synthetic-home-with-proxy', USERPROFILE: 'C:\\synthetic-proxy-home' },
    nonce: NONCE,
    spawnDocker(args, childEnvironment) {
      assert.equal(args[0], '--config');
      assert.deepEqual(readdirSync(args[1]), []);
      assert.equal(childEnvironment.HOME, undefined);
      assert.equal(childEnvironment.USERPROFILE, undefined);
      observed = true;
      return fakeDockerChild();
    },
  });
  assert.equal(observed, true);
});

test('context changes after preflight cannot move run or cleanup to another daemon', async () => {
  const mock = makeDocker({ containerState: 'present' });
  let changed = false;
  const result = await runDockerExample({
    execDocker: async (args, environment) => {
      if (args.includes('image')) changed = true;
      if (changed && args.includes('container')) {
        assert.equal(args[args.indexOf('--host') + 1], 'npipe:////./pipe/docker_engine');
      }
      return mock.execDocker(args, environment);
    },
    environment: {}, nonce: NONCE,
    spawnDocker(args) {
      assert.equal(args[args.indexOf('--host') + 1], 'npipe:////./pipe/docker_engine');
      return fakeDockerChild();
    },
  });
  assert.equal(changed, true);
  assert.equal(result.cleanup, 'verified_absent');
});

test('WSL probe passes its local endpoint and isolated in-distro config to every Docker call', async () => {
  const mock = makeDocker({ endpoint: 'unix:///var/run/docker.sock' });
  let removed = false;
  const result = await runDockerExample({
    execDocker: mock.execDocker,
    environment: { RISK_FORK_DOCKER_WSL_DISTRO: 'Ubuntu-24.04' },
    platform: 'win32', nonce: NONCE,
    async createConfig(command, _environment, distro) {
      assert.equal(command.binary, 'wsl.exe');
      assert.equal(distro, 'Ubuntu-24.04');
      return { directory: '/tmp/rf-docker-cli-mock', remove: async () => { removed = true; } };
    },
    spawnDocker(args) {
      assert.deepEqual(args.slice(0, 4), [
        '--config', '/tmp/rf-docker-cli-mock', '--host', 'unix:///var/run/docker.sock',
      ]);
      return fakeDockerChild();
    },
  });
  assert.equal(result.cleanup, 'verified_absent');
  assert.equal(removed, true);
  assert.equal(mock.boundCalls.filter((call) => call.command[0] === 'container')
    .every((call) => call.config === '/tmp/rf-docker-cli-mock'
      && call.host === 'unix:///var/run/docker.sock'), true);
});

test('failed run removes only an exact-owned container and verifies absence', async () => {
  const mock = makeDocker({ containerState: 'present' });
  await assert.rejects(runDockerExample({
    execDocker: mock.execDocker, environment: {}, nonce: NONCE,
    spawnDocker() { return fakeDockerChild({ exitCode: 1 }); },
  }), (error) => error.code === 'DOCKER_RUN_FAILED' && error.cleanup === 'verified_absent');
  assert.equal(mock.calls.some((args) => args[0] === 'container' && args[1] === 'rm'), true);
});

test('serve-mode child stdin error fails closed but still verifies exact owned cleanup', async () => {
  const mock = makeDocker({ containerState: 'present' });
  const clientInput = new PassThrough();
  await assert.rejects(runDockerExample({
    mode: 'serve', execDocker: mock.execDocker, environment: {}, nonce: NONCE,
    stdin: clientInput,
    spawnDocker() {
      const child = fakeDockerChild({ closeOnInput: false });
      queueMicrotask(() => child.stdin.emit('error', new Error('EPIPE')));
      return child;
    },
  }), (error) => error.code === 'DOCKER_STDIN_FAILED' && error.cleanup === 'verified_absent');
  assert.equal(mock.calls.some((args) => args[0] === 'container' && args[1] === 'rm'), true);
});

test('unclosed Docker client never reports verified cleanup', async () => {
  const mock = makeDocker({ containerState: 'present' });
  await assert.rejects(runDockerExample({
    execDocker: mock.execDocker, environment: {}, nonce: NONCE, probeTimeoutMs: 1,
    spawnDocker() {
      const child = fakeDockerChild({ closeOnInput: false });
      child.kill = () => true;
      return child;
    },
  }), (error) => error.code === 'DOCKER_CHILD_NOT_CLOSED' && error.cleanup === 'unknown');
  assert.equal(mock.calls.some((args) => args[0] === 'container' && args[1] === 'rm'), true);
});

test('ownership mismatch or daemon failure never authorizes container removal', async () => {
  for (const [state, ownerNonce] of [['present', 'd'.repeat(32)], ['daemon_error', NONCE]]) {
    const mock = makeDocker({ containerState: state, ownerNonce });
    await assert.rejects(cleanupDockerExample({
      execDocker: mock.execDocker, environment: {}, name: NAME, nonce: NONCE,
    }), /CONTAINER_(?:OWNERSHIP|ABSENCE)_UNKNOWN/);
    assert.equal(mock.calls.some((args) => args[0] === 'container' && args[1] === 'rm'), false);
  }
});
