#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IMAGE = 'node:22-alpine';
const FIXTURE_SHA256 = 'b8886a8d57e7414962c3a9e3eaa281db254bff1793daa3dc2135f025148c96d2';
const FIXTURE_URL = new URL('./synthetic-mcp.mjs', import.meta.url);
const LABEL = 'agoragentic.risk-fork.local-docker-example.nonce';
const MAX_FIXTURE_BYTES = 12 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 20_000;
const SERVE_TIMEOUT_MS = 60_000;
const ALLOWED_IMAGE_ENV_KEYS = new Set(['PATH', 'NODE_VERSION', 'YARN_VERSION']);

export const DOCKER_EXAMPLE_TRUTH = Object.freeze({
  schema: 'agoragentic.risk-fork.local-docker-example.v1',
  demo_only: true,
  provider_calls: 0,
  network_used: false,
  credentials_used: false,
  authority_granted: false,
  clean_commit_performed: false,
  e2b_qualified: false,
  live_traffic_protected: false,
  isolation_scope: 'local_docker_container_only',
});

export class DockerExampleError extends Error {
  constructor(code, cleanup = 'not_started') {
    super(code);
    this.name = 'DockerExampleError';
    this.code = code;
    this.cleanup = cleanup;
  }
}

function minimalDockerEnvironment(environment) {
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
    if (environment[key]) throw new DockerExampleError('REMOTE_OR_CUSTOM_DOCKER_CONTEXT_BLOCKED');
  }
  return Object.fromEntries(Object.entries({
    PATH: environment.PATH,
    Path: environment.Path,
    HOME: environment.HOME,
    USERPROFILE: environment.USERPROFILE,
    APPDATA: environment.APPDATA,
    LOCALAPPDATA: environment.LOCALAPPDATA,
    SystemRoot: environment.SystemRoot,
    WINDIR: environment.WINDIR,
    TEMP: environment.TEMP,
    TMP: environment.TMP,
    TMPDIR: environment.TMPDIR,
  }).filter(([, value]) => typeof value === 'string' && value.length > 0));
}

function boundDockerEnvironment(environment) {
  return Object.fromEntries(Object.entries({
    PATH: environment.PATH,
    Path: environment.Path,
    SystemRoot: environment.SystemRoot,
    WINDIR: environment.WINDIR,
    TEMP: environment.TEMP,
    TMP: environment.TMP,
    TMPDIR: environment.TMPDIR,
  }).filter(([, value]) => typeof value === 'string' && value.length > 0));
}

async function createEmptyDockerConfig(command, environment, distro) {
  if (command.binary === 'wsl.exe') {
    const { stdout } = await execFileAsync('wsl.exe', [
      '-d', distro, '--exec', 'mktemp', '-d', '/tmp/rf-docker-cli-XXXXXXXX',
    ], { env: environment, windowsHide: true, timeout: 7_000, maxBuffer: 1024 });
    const directory = stdout.trim();
    if (!/^\/tmp\/rf-docker-cli-[A-Za-z0-9]{8}$/u.test(directory)) {
      throw new DockerExampleError('DOCKER_CONFIG_UNVERIFIED');
    }
    return {
      directory,
      async remove() {
        await execFileAsync('wsl.exe', ['-d', distro, '--exec', 'rmdir', '--', directory], {
          env: environment, windowsHide: true, timeout: 7_000, maxBuffer: 1024,
        });
      },
    };
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rf-docker-cli-'));
  return { directory, remove: () => rmdir(directory) };
}

export function dockerCommandForEnvironment(environment = process.env, platform = process.platform) {
  const distro = environment.RISK_FORK_DOCKER_WSL_DISTRO;
  if (distro !== undefined) {
    if (platform !== 'win32' || !/^[A-Za-z0-9._-]{1,80}$/u.test(distro)) {
      throw new DockerExampleError('DOCKER_WSL_DISTRO_INVALID');
    }
    return Object.freeze({
      binary: 'wsl.exe',
      prefix: ['-d', distro, '--exec', 'env', '-u', 'DOCKER_HOST', '-u', 'DOCKER_CONTEXT',
        '-u', 'DOCKER_CONFIG', '-u', 'DOCKER_TLS_VERIFY', '-u', 'DOCKER_CERT_PATH', 'docker'],
    });
  }
  return Object.freeze({ binary: platform === 'win32' ? 'docker.exe' : 'docker', prefix: [] });
}

async function defaultExec(args, environment, command) {
  try {
    const { stdout, stderr } = await execFileAsync(command.binary, [...command.prefix, ...args], {
      env: environment,
      windowsHide: true,
      timeout: command.binary === 'wsl.exe' ? 30_000 : 7_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'utf8',
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code };
  }
}

function defaultSpawn(args, environment, command) {
  return spawn(command.binary, [...command.prefix, ...args], {
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function requireResult(result, code) {
  if (!result?.ok || typeof result.stdout !== 'string' || result.stdout.length > MAX_OUTPUT_BYTES) {
    throw new DockerExampleError(code);
  }
  return result.stdout.trim();
}

async function readReviewedFixture(readFixture) {
  const bytes = await readFixture(FIXTURE_URL);
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FIXTURE_BYTES) {
    throw new DockerExampleError('FIXTURE_INTEGRITY_UNVERIFIED');
  }
  // Git may check out CRLF on Windows; bind the canonical LF source bytes.
  const source = bytes.toString('utf8').replaceAll('\r\n', '\n');
  if (createHash('sha256').update(source, 'utf8').digest('hex') !== FIXTURE_SHA256) {
    throw new DockerExampleError('FIXTURE_INTEGRITY_UNVERIFIED');
  }
  return source;
}

function parseLocalEndpoint(value) {
  let endpoint;
  try { endpoint = JSON.parse(value); } catch { throw new DockerExampleError('DOCKER_ENDPOINT_UNVERIFIED'); }
  if (typeof endpoint !== 'string'
    || !(endpoint.startsWith('unix:///') || endpoint.startsWith('npipe:////./pipe/'))) {
    throw new DockerExampleError('REMOTE_DOCKER_ENDPOINT_BLOCKED');
  }
  return endpoint;
}

function validateImage(value) {
  let image;
  try { image = JSON.parse(value); } catch { throw new DockerExampleError('LOCAL_IMAGE_UNVERIFIED'); }
  if (!image || image.Os !== 'linux' || !/^sha256:[a-f0-9]{64}$/u.test(image.Id ?? '')
    || !Array.isArray(image.RepoTags) || !image.RepoTags.includes(IMAGE)
    || !image.Config || (image.Config.Volumes && Object.keys(image.Config.Volumes).length > 0)
    || image.Config.Healthcheck) {
    throw new DockerExampleError('LOCAL_IMAGE_UNVERIFIED');
  }
  const env = image.Config.Env;
  if (!Array.isArray(env) || env.some((entry) => {
    if (typeof entry !== 'string' || !entry.includes('=')) return true;
    return !ALLOWED_IMAGE_ENV_KEYS.has(entry.slice(0, entry.indexOf('=')));
  })) {
    throw new DockerExampleError('LOCAL_IMAGE_ENV_UNVERIFIED');
  }
  return image.Id;
}

export async function preflightDockerExample({
  execDocker,
  readFixture = readFile,
  environment = process.env,
  platform = process.platform,
} = {}) {
  const command = dockerCommandForEnvironment(environment, platform);
  const execute = execDocker ?? ((args, env) => defaultExec(args, env, command));
  const dockerEnvironment = minimalDockerEnvironment(environment);
  const source = await readReviewedFixture(readFixture);
  const context = requireResult(await execute(['context', 'show'], dockerEnvironment), 'DOCKER_CONTEXT_UNAVAILABLE');
  if (!/^[A-Za-z0-9._-]{1,80}$/u.test(context)) {
    throw new DockerExampleError('DOCKER_CONTEXT_UNVERIFIED');
  }
  const endpoint = parseLocalEndpoint(requireResult(await execute([
    'context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}',
  ], dockerEnvironment), 'DOCKER_ENDPOINT_UNAVAILABLE'));
  if (requireResult(await execute(['--host', endpoint, 'info', '--format', '{{.OSType}}'], dockerEnvironment),
    'DOCKER_DAEMON_UNAVAILABLE') !== 'linux') {
    throw new DockerExampleError('LINUX_CONTAINER_ENGINE_REQUIRED');
  }
  const imageId = validateImage(requireResult(await execute(['--host', endpoint,
    'image', 'inspect', IMAGE, '--format', '{{json .}}',
  ], dockerEnvironment), 'LOCAL_IMAGE_MISSING_NO_PULL'));
  return Object.freeze({ dockerEnvironment, source, imageId, endpoint });
}

export function dockerRunArgs({ name, nonce, source, imageId }) {
  if (!/^rf-local-mcp-[a-f0-9]{32}$/u.test(name) || !/^[a-f0-9]{32}$/u.test(nonce)
    || name !== `rf-local-mcp-${nonce}` || typeof source !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(imageId)) {
    throw new DockerExampleError('DOCKER_RUN_BINDING_INVALID');
  }
  return [
    'run', '--pull=never', '--rm', '-i',
    `--name=${name}`, `--label=${LABEL}=${nonce}`,
    '--network=none', '--read-only', '--user=65534:65534',
    '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--pids-limit=32', '--memory=256m', '--cpus=0.5',
    '--no-healthcheck', '--entrypoint=node',
    imageId, '--input-type=module', '--eval', source,
  ];
}

function isExactNotFound(result, name) {
  return !result.ok && typeof result.stderr === 'string'
    && (result.stderr.includes(`No such object: ${name}`)
      || result.stderr.includes(`No such container: ${name}`));
}

async function inspectOwnedContainer(execDocker, environment, name, nonce) {
  const result = await execDocker([
    'container', 'inspect', name, '--format', '{{json .}}',
  ], environment);
  if (isExactNotFound(result, name)) return null;
  const value = requireResult(result, 'CONTAINER_ABSENCE_UNKNOWN');
  let container;
  try { container = JSON.parse(value); } catch { throw new DockerExampleError('CONTAINER_IDENTITY_UNKNOWN'); }
  if (container?.Name !== `/${name}` || container.Config?.Labels?.[LABEL] !== nonce
    || !/^[a-f0-9]{64}$/u.test(container.Id ?? '')) {
    throw new DockerExampleError('CONTAINER_OWNERSHIP_UNKNOWN');
  }
  return container.Id;
}

export async function cleanupDockerExample({ execDocker, environment, name, nonce }) {
  const id = await inspectOwnedContainer(execDocker, environment, name, nonce);
  if (id === null) return 'verified_absent';
  requireResult(await execDocker(['container', 'rm', '--force', id], environment), 'CONTAINER_REMOVAL_UNKNOWN');
  if (await inspectOwnedContainer(execDocker, environment, name, nonce) !== null) {
    throw new DockerExampleError('CONTAINER_ABSENCE_UNKNOWN');
  }
  return 'verified_absent';
}

function probeRequests() {
  return {
    initialize: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'local-no-spend-probe', version: '1' },
    } },
    initialized: { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    list: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    call: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'risk_fork_synthetic_untrusted_tool', arguments: {},
    } },
  };
}

function verifyProbeResponse(response, stage) {
  if (response?.jsonrpc !== '2.0' || response.id !== stage + 1 || response.error) {
    throw new DockerExampleError('MCP_RESPONSE_INVALID');
  }
  const result = response.result;
  if (stage === 0) {
    if (result?.protocolVersion !== '2025-06-18'
      || result.serverInfo?.name !== 'risk-fork-local-docker-synthetic') {
      throw new DockerExampleError('MCP_RESPONSE_INVALID');
    }
    return;
  }
  if (stage === 1) {
    if (result?.tools?.length !== 1
      || result.tools[0]?.name !== 'risk_fork_synthetic_untrusted_tool'
      || !result.tools[0]?.description?.includes('SYNTHETIC UNTRUSTED MCP DESCRIPTION')) {
      throw new DockerExampleError('MCP_RESPONSE_INVALID');
    }
    return;
  }
  if (stage !== 2 || result?.structuredContent?.schema !== DOCKER_EXAMPLE_TRUTH.schema) {
    throw new DockerExampleError('MCP_RESPONSE_INVALID');
  }
  for (const key of ['demo_only', 'provider_calls', 'network_used', 'credentials_used',
    'authority_granted', 'clean_commit_performed', 'e2b_qualified', 'live_traffic_protected']) {
    if (result.structuredContent[key] !== DOCKER_EXAMPLE_TRUTH[key]) {
      throw new DockerExampleError('MCP_TRUTH_INVALID');
    }
  }
  if (result.structuredContent.result !== 'synthetic_untrusted_data') {
    throw new DockerExampleError('MCP_RESPONSE_INVALID');
  }
}

async function runChild(child, { mode, timeoutMs, stdout = process.stdout, stdin = process.stdin }) {
  let pending = '';
  let probeStage = 0;
  let protocolFailure = null;
  let inputFailure = false;
  let outputBytes = 0;
  let diagnosticBytes = 0;
  let timedOut = false;
  const requests = mode === 'probe' ? probeRequests() : null;
  const failInput = () => {
    inputFailure = true;
    child.kill();
  };
  child.stdin.on('error', failInput);
  const sendProbe = (request, end = false) => {
    try {
      const line = `${JSON.stringify(request)}\n`;
      if (end) child.stdin.end(line);
      else child.stdin.write(line);
    } catch {
      failInput();
    }
  };
  const exit = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      clearTimeout(hardGrace);
      resolve(value);
    };
    let grace;
    let hardGrace;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      grace = setTimeout(() => {
        child.kill('SIGKILL');
        hardGrace = setTimeout(() => finish({ code: null, signal: 'unclosed' }), 2_000);
      }, 2_000);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        protocolFailure = new DockerExampleError('DOCKER_OUTPUT_LIMIT');
        child.kill();
        return;
      }
      if (mode !== 'probe') {
        stdout.write(chunk);
        return;
      }
      pending += chunk.toString('utf8');
      let newline;
      while (!protocolFailure && (newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/u, '');
        pending = pending.slice(newline + 1);
        try {
          verifyProbeResponse(JSON.parse(line), probeStage);
          if (pending.length > 0) throw new DockerExampleError('MCP_RESPONSE_INVALID');
          probeStage += 1;
          if (probeStage === 1) {
            sendProbe(requests.initialized);
            sendProbe(requests.list);
          } else if (probeStage === 2) {
            sendProbe(requests.call);
          } else if (probeStage === 3) {
            child.stdin.end();
          }
        } catch (error) {
          protocolFailure = error instanceof DockerExampleError
            ? error : new DockerExampleError('MCP_RESPONSE_INVALID');
          child.kill();
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      diagnosticBytes += Buffer.byteLength(chunk);
      if (diagnosticBytes > MAX_OUTPUT_BYTES) child.kill();
    });
    child.once('error', () => finish({ code: null, signal: 'unclosed' }));
    child.once('close', (code, signal) => finish({ code, signal }));
    if (mode === 'probe') sendProbe(requests.initialize);
    else {
      try { stdin.pipe(child.stdin); } catch { failInput(); }
    }
  });
  if (mode === 'serve') stdin.unpipe(child.stdin);
  if (exit.signal === 'unclosed') throw new DockerExampleError('DOCKER_CHILD_NOT_CLOSED', 'unknown');
  if (timedOut) throw new DockerExampleError('DOCKER_RUN_TIMEOUT');
  if (inputFailure) throw new DockerExampleError('DOCKER_STDIN_FAILED');
  if (protocolFailure) throw protocolFailure;
  if (outputBytes > MAX_OUTPUT_BYTES || diagnosticBytes > MAX_OUTPUT_BYTES) {
    throw new DockerExampleError('DOCKER_OUTPUT_LIMIT');
  }
  if (exit.code !== 0 || diagnosticBytes !== 0) throw new DockerExampleError('DOCKER_RUN_FAILED');
  if (mode === 'probe' && (probeStage !== 3 || pending.length > 0)) {
    throw new DockerExampleError('MCP_RESPONSE_INVALID');
  }
}

export async function runDockerExample({
  mode = 'probe',
  execDocker,
  spawnDocker,
  readFixture = readFile,
  environment = process.env,
  platform = process.platform,
  stdin = process.stdin,
  stdout = process.stdout,
  signalEmitter = process,
  nonce = randomBytes(16).toString('hex'),
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  createConfig = createEmptyDockerConfig,
} = {}) {
  if (!['probe', 'serve'].includes(mode) || !/^[a-f0-9]{32}$/u.test(nonce)
    || !Number.isInteger(probeTimeoutMs) || probeTimeoutMs < 1 || probeTimeoutMs > PROBE_TIMEOUT_MS) {
    throw new DockerExampleError('EXAMPLE_ARGUMENT_INVALID');
  }
  const command = dockerCommandForEnvironment(environment, platform);
  const execute = execDocker ?? ((args, env) => defaultExec(args, env, command));
  const launch = spawnDocker ?? ((args, env) => defaultSpawn(args, env, command));
  const { dockerEnvironment, source, imageId, endpoint } = await preflightDockerExample({
    execDocker: execute, readFixture, environment, platform,
  });
  const isolatedEnvironment = boundDockerEnvironment(dockerEnvironment);
  const config = await createConfig(command, isolatedEnvironment,
    environment.RISK_FORK_DOCKER_WSL_DISTRO);
  const bind = (args) => ['--config', config.directory, '--host', endpoint, ...args];
  const executeBound = (args) => execute(bind(args), isolatedEnvironment);
  const name = `rf-local-mcp-${nonce}`;
  const args = dockerRunArgs({ name, nonce, source, imageId });
  let failure = null;
  let child = null;
  let interrupted = false;
  let cleaning = false;
  const interrupt = () => {
    interrupted = true;
    if (!cleaning) child?.kill();
  };
  signalEmitter.on('SIGINT', interrupt);
  signalEmitter.on('SIGTERM', interrupt);
  try {
    try {
      child = launch(bind(args), isolatedEnvironment);
      try {
        await runChild(child, {
          mode, timeoutMs: mode === 'probe' ? probeTimeoutMs : SERVE_TIMEOUT_MS, stdin, stdout,
        });
      } catch (error) {
        if (interrupted) throw new DockerExampleError('DOCKER_RUN_INTERRUPTED');
        throw error;
      }
      if (interrupted) throw new DockerExampleError('DOCKER_RUN_INTERRUPTED');
    } catch (error) {
      failure = error instanceof DockerExampleError ? error : new DockerExampleError('DOCKER_RUN_FAILED');
    }
    cleaning = true;
    let cleanup;
    try {
      cleanup = await cleanupDockerExample({
        execDocker: executeBound, environment: isolatedEnvironment, name, nonce,
      });
    } catch {
      throw new DockerExampleError('CONTAINER_CLEANUP_UNKNOWN', 'unknown');
    }
    if (interrupted && !failure) failure = new DockerExampleError('DOCKER_RUN_INTERRUPTED');
    if (failure) {
      failure.cleanup = failure.code === 'DOCKER_CHILD_NOT_CLOSED' ? 'unknown' : cleanup;
      throw failure;
    }
    return Object.freeze({
      ...DOCKER_EXAMPLE_TRUTH,
      status: mode === 'probe' ? 'verified_local_mcp_probe' : 'local_mcp_session_ended',
      transport: 'docker_stdio_json_rpc',
      image_ref: IMAGE,
      image_id: imageId,
      fixture_sha256: `sha256:${FIXTURE_SHA256}`,
      cleanup,
    });
  } finally {
    signalEmitter.off('SIGINT', interrupt);
    signalEmitter.off('SIGTERM', interrupt);
    try { await config.remove(); } catch {
      throw new DockerExampleError('DOCKER_CONFIG_CLEANUP_UNKNOWN', 'unknown');
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2];
  if (!['probe', 'serve'].includes(mode) || process.argv.length !== 3) {
    process.stderr.write('Usage: node runner.mjs probe|serve\n');
    process.exitCode = 2;
  } else {
    runDockerExample({ mode }).then((result) => {
      const target = mode === 'probe' ? process.stdout : process.stderr;
      target.write(`${JSON.stringify(result)}\n`);
    }).catch((error) => {
      process.stderr.write(`${JSON.stringify({
        status: 'failed', code: error?.code ?? 'DOCKER_EXAMPLE_FAILED',
        cleanup: error?.cleanup ?? 'not_started',
      })}\n`);
      process.exitCode = 2;
    });
  }
}
