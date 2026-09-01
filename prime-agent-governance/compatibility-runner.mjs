import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { types } from 'node:util';

import {
  PRIME_AGENT_REQUIRED_RPC_COMMANDS,
  PRIME_AGENT_HOST_CONTRACT,
  PRIME_AGENT_HOST_IDENTITY,
} from './host-contract.mjs';
import {
  validatePrimeAgentPackageMetadata,
  verifyPrimeAgentReleaseArtifact,
} from './release-verifier.mjs';
import {
  buildPrimeAgentDependencyIntegrity,
  buildPrimeAgentExtensionIntegrity,
  buildTreeIntegrity,
  integritySha256,
  loadPrimeAgentIntegrityProfile,
  selectPrimeAgentDependencyClosure,
} from './artifact-integrity.mjs';

export const PRIME_AGENT_COMPATIBILITY_RECEIPT_SCHEMA = 'agoragentic.prime-agent.released-compatibility-receipt.v1';

const RECEIPT_BOUNDARY_KEYS = Object.freeze([
  'credentials_used',
  'paid_provider_calls',
  'network_authority_granted',
  'spend_authorized',
  'wallet_mutated',
  'settlement_mutated',
  'production_deployed',
  'package_published',
  'outreach_performed',
  'public_compatibility_claimed',
  'trust_mutated',
  'ranking_mutated',
]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const MAX_RECEIPT_JSON_DEPTH = 64;
const MAX_RECEIPT_JSON_NODES = 10_000;
const MAX_RECEIPT_PUBLIC_STRING_LENGTH = 4096;
const RECEIPT_SECRET_LIKE_PATTERNS = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:amk_|sk-|sk_live_|sk_test_|rk_live_|rk_test_|whsec_|gh[pousr]_|github_pat_|glpat[-_]|glrt-|glft-|gldt-|npm_[A-Za-z0-9][A-Za-z0-9_-]{23,}|hf_[A-Za-z0-9][A-Za-z0-9_-]{23,}|pypi-|dop_v1_|shpat_|shpca_|shppa_|shpss_|xox[bcaprs]-)[A-Za-z0-9._-]{8,}/i,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[A-Za-z0-9_-]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP |ENCRYPTED )?[A-Z ]*PRIVATE KEY-----/i,
  /\b(?:api[_ -]?key|account[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|authorization)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i,
]);
const RECEIPT_PRIVATE_PATH_PATTERN = /(?:^|[\s("'`=:\[\]{},;])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|~[\\/]|\/(?:Users|Volumes|home|root|tmp|private|etc|opt|mnt|workspace|srv|usr|run|var)(?:[\\/]|$)|file:\/\/)/i;

const RPC_INPUT = Object.freeze([
  { id: 'state-1', type: 'get_state' },
  { id: 'commands-1', type: 'get_commands' },
  { id: 'status-1', type: 'prompt', message: '/agora-status' },
  { id: 'abort-1', type: 'abort' },
  { id: 'observe-1', type: 'observe', activeSessionId: 'agoragentic-missing-session' },
  { id: 'unobserve-1', type: 'unobserve', activeSessionId: 'agoragentic-missing-session' },
]);

export const PRIME_AGENT_COMPATIBILITY_CASE_IDS = Object.freeze([
  'jsonl_lf_framing',
  'get_state',
  'extension_discovery',
  'extension_command_load',
  'abort_idle',
  'observe_missing',
  'unobserve_missing',
  'malformed_frame',
  'unknown_command',
  'eof_shutdown',
]);

export const PRIME_AGENT_COMPATIBILITY_CASE_SUMMARIES = Object.freeze({
  jsonl_lf_framing: 'Every stdout record was valid JSON with LF-only framing.',
  get_state: 'Provider-free state was returned idle.',
  extension_discovery: 'Released host reported the Agoragentic command as an extension.',
  extension_command_load: 'The loaded extension command ran without granting authority.',
  abort_idle: 'Idle abort returned a truthful successful response.',
  observe_missing: 'Missing observed session failed explicitly.',
  unobserve_missing: 'Unobserving a missing session was idempotent.',
  malformed_frame: 'Malformed JSON failed closed.',
  unknown_command: 'Unknown RPC commands failed explicitly.',
  eof_shutdown: 'EOF produced a clean process exit.',
});

export const PRIME_AGENT_EXPECTED_COMPATIBILITY_MESSAGE_COUNT = 9;

const PRIME_AGENT_EXPECTED_COMPATIBILITY_MATRIX = Object.freeze(
  PRIME_AGENT_COMPATIBILITY_CASE_IDS.map((id) => Object.freeze({
    id,
    status: 'passed',
    summary: PRIME_AGENT_COMPATIBILITY_CASE_SUMMARIES[id],
  })),
);
const EMPTY_OUTPUT_SHA256 = integritySha256('');
const RUNTIME_ROOT_PREFIX = 'agoragentic-prime-agent-compat-';
const RUNTIME_MARKER_FILE = '.agoragentic-prime-agent-runtime';
const RUNTIME_HANDLE_STATE = new WeakMap();
const SUCCESSFUL_COMPATIBILITY_RESULTS = new WeakMap();

export function buildPrimeAgentSafeChildEnvironment(runtimeRoot, hostEnvironment = process.env) {
  const allowedHostKeys = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'LANG',
    'LC_ALL',
  ];
  const env = Object.fromEntries(
    allowedHostKeys
      .filter((key) => typeof hostEnvironment[key] === 'string')
      .map((key) => [key, hostEnvironment[key]]),
  );
  const isolatedHome = join(runtimeRoot, 'home');
  return {
    ...env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: join(isolatedHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(isolatedHome, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(isolatedHome, '.config'),
    XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
    XDG_CACHE_HOME: join(isolatedHome, '.cache'),
    XDG_STATE_HOME: join(isolatedHome, '.local', 'state'),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PRIME_AGENT_TELEMETRY: '0',
    PRIME_AGENT_CODING_AGENT_DIR: join(runtimeRoot, 'agent'),
    PRIME_AGENT_SESSION_DIR: join(runtimeRoot, 'sessions'),
    TMP: join(runtimeRoot, 'tmp'),
    TEMP: join(runtimeRoot, 'tmp'),
    AGORAGENTIC_NO_SPEND: '1',
    AGORAGENTIC_ALLOW_REAL_SPEND: '0',
    AGORAGENTIC_ALLOW_NETWORK_CANARIES: '0',
  };
}

function daemonSocketForRuntime(runtimeRoot) {
  const suffix = basename(runtimeRoot).replace(/[^A-Za-z0-9_-]/g, '-');
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${suffix}`
    : join(runtimeRoot, 'prime-agent-daemon.sock');
}

function validRuntimeHandleState(handle) {
  if (!handle || typeof handle !== 'object') return null;
  const state = RUNTIME_HANDLE_STATE.get(handle);
  if (!state) return null;
  if (
    handle.runtime_root !== state.runtimeRoot
    || handle.daemon_socket !== state.socketPath
    || dirname(state.runtimeRoot) !== resolve(tmpdir())
    || !basename(state.runtimeRoot).startsWith(RUNTIME_ROOT_PREFIX)
  ) return null;
  try {
    if (readFileSync(join(state.runtimeRoot, RUNTIME_MARKER_FILE), 'utf8') !== state.markerToken) {
      return null;
    }
  } catch {
    return null;
  }
  return state;
}

export function createPrimeAgentCompatibilityRuntimeHandle() {
  const runtimeRoot = mkdtempSync(join(tmpdir(), RUNTIME_ROOT_PREFIX));
  const socketPath = daemonSocketForRuntime(runtimeRoot);
  const markerToken = randomUUID();
  try {
    writeFileSync(join(runtimeRoot, RUNTIME_MARKER_FILE), markerToken, { encoding: 'utf8', flag: 'wx' });
    mkdirSync(join(runtimeRoot, 'agent'), { recursive: true });
    mkdirSync(join(runtimeRoot, 'sessions'), { recursive: true });
    mkdirSync(join(runtimeRoot, 'tmp'), { recursive: true });
    mkdirSync(join(runtimeRoot, 'home', 'AppData', 'Roaming'), { recursive: true });
    mkdirSync(join(runtimeRoot, 'home', 'AppData', 'Local'), { recursive: true });
    mkdirSync(join(runtimeRoot, 'home', '.config'), { recursive: true });
    mkdirSync(join(runtimeRoot, 'home', '.local', 'share'), { recursive: true });
    mkdirSync(join(runtimeRoot, 'home', '.cache'), { recursive: true });
    mkdirSync(join(runtimeRoot, 'home', '.local', 'state'), { recursive: true });
  } catch (error) {
    rmSync(runtimeRoot, { recursive: true, force: true });
    throw error;
  }
  const handle = Object.freeze({ runtime_root: runtimeRoot, daemon_socket: socketPath });
  RUNTIME_HANDLE_STATE.set(handle, { runtimeRoot, socketPath, markerToken });
  return handle;
}

export function shutdownPrimeAgentDaemon(packageRoot, runtimeHandle, {
  exitConfirmationTimeoutMs = 5_000,
  pollIntervalMs = 100,
} = {}) {
  const runtimeState = validRuntimeHandleState(runtimeHandle);
  if (!runtimeState) return false;
  const { runtimeRoot, socketPath } = runtimeState;
  const boundedExitTimeoutMs = Number.isInteger(exitConfirmationTimeoutMs)
    ? Math.max(200, Math.min(exitConfirmationTimeoutMs, 10_000))
    : 5_000;
  const boundedPollIntervalMs = Number.isInteger(pollIntervalMs)
    ? Math.max(10, Math.min(pollIntervalMs, 500))
    : 100;
  const daemonClientUrl = pathToFileURL(
    join(packageRoot, 'dist', 'modes', 'daemon', 'daemon-client.js'),
  ).href;
  const script = `
    import { createConnection } from 'node:net';
    import { DaemonClient } from ${JSON.stringify(daemonClientUrl)};

    const socketPath = process.argv[1];
    const exitConfirmationTimeoutMs = Number(process.argv[2]);
    const pollIntervalMs = Number(process.argv[3]);
    const unreachableCodes = new Set(['ENOENT', 'ECONNREFUSED']);

    function delay(ms) {
      return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
    }

    function probeEndpoint() {
      return new Promise((resolveProbe) => {
        const socket = createConnection(socketPath);
        let settled = false;
        const finish = (status) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolveProbe(status);
        };
        const timer = setTimeout(() => finish('unknown'), Math.min(500, pollIntervalMs * 2));
        socket.once('connect', () => finish('reachable'));
        socket.once('error', (error) => {
          finish(unreachableCodes.has(error?.code) ? 'unreachable' : 'unknown');
        });
      });
    }

    async function confirmEndpointExited() {
      const deadline = Date.now() + exitConfirmationTimeoutMs;
      let consecutiveUnreachable = 0;
      while (Date.now() < deadline) {
        const status = await probeEndpoint();
        consecutiveUnreachable = status === 'unreachable' ? consecutiveUnreachable + 1 : 0;
        if (consecutiveUnreachable >= 2) return true;
        const remainingMs = deadline - Date.now();
        if (remainingMs > 0) await delay(Math.min(pollIntervalMs, remainingMs));
      }
      return false;
    }

    const initialEndpointStatus = await probeEndpoint();
    if (initialEndpointStatus === 'unreachable') {
      if (!(await confirmEndpointExited())) process.exitCode = 1;
      process.exit();
    }
    if (initialEndpointStatus !== 'reachable') process.exit(1);

    const client = new DaemonClient(process.argv[1]);
    let shutdownAcknowledged = false;
    try {
      await client.connect(3000);
      await client.waitForHello(3000);
      const response = await client.request({ type: 'shutdown', force: true }, 5000);
      shutdownAcknowledged = response?.success === true;
    } catch {
      process.exitCode = 1;
    } finally {
      client.close();
    }
    if (!shutdownAcknowledged || !(await confirmEndpointExited())) process.exitCode = 1;
  `;
  const child = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    script,
    socketPath,
    String(boundedExitTimeoutMs),
    String(boundedPollIntervalMs),
  ], {
    cwd: runtimeRoot,
    env: buildPrimeAgentSafeChildEnvironment(runtimeRoot),
    encoding: 'utf8',
    timeout: Math.max(15_000, boundedExitTimeoutMs + 12_000),
    maxBuffer: 512 * 1024,
    windowsHide: true,
  });
  return child.status === 0 && child.signal === null && child.error === undefined;
}

function removeRuntimeRoot(runtimeRoot) {
  const sleepCell = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(runtimeRoot, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) return false;
      Atomics.wait(sleepCell, 0, 0, 100);
    }
  }
  return false;
}

export function finalizePrimeAgentRuntimeRoot(runtimeHandle, { shutdownConfirmed } = {}) {
  if (shutdownConfirmed !== true) return false;
  const runtimeState = validRuntimeHandleState(runtimeHandle);
  if (!runtimeState) return false;
  const removed = removeRuntimeRoot(runtimeState.runtimeRoot);
  if (removed) RUNTIME_HANDLE_STATE.delete(runtimeHandle);
  return removed;
}

function parseTranscript(stdout) {
  const messages = [];
  const invalidLines = [];
  const carriageReturnCount = (String(stdout || '').match(/\r/g) || []).length;
  for (const line of String(stdout || '').split('\n')) {
    const candidate = line;
    if (!candidate) continue;
    try {
      messages.push(JSON.parse(candidate));
    } catch {
      invalidLines.push(candidate.slice(0, 200));
    }
  }
  return { messages, invalidLines, carriageReturnCount };
}

function isValidRfc3339Utc(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_TIME_PATTERN.exec(value);
  if (!match) return false;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return false;
  const date = new Date(timestamp);
  const expected = match.slice(1, 7).map(Number);
  const observed = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ];
  return observed.every((part, index) => part === expected[index]);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isArrayIndexKey(key, length) {
  if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function snapshotClosedJsonValue(value, path = 'receipt') {
  const state = { ancestors: new WeakSet(), nodes: 0 };

  function visit(current, currentPath, depth) {
    state.nodes += 1;
    if (state.nodes > MAX_RECEIPT_JSON_NODES) {
      throw new TypeError(`${path} exceeds the JSON node limit`);
    }
    if (depth > MAX_RECEIPT_JSON_DEPTH) {
      throw new TypeError(`${path} exceeds the JSON depth limit`);
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError(`${currentPath} contains a non-finite number`);
      return current;
    }
    if (typeof current !== 'object') throw new TypeError(`${currentPath} contains a non-JSON value`);
    if (types.isProxy(current)) throw new TypeError(`${currentPath} must not be a Proxy`);
    if (state.ancestors.has(current)) throw new TypeError(`${currentPath} must not contain a cycle`);

    state.ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          throw new TypeError(`${currentPath} must use the standard Array prototype`);
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(current, 'length');
        if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) {
          throw new TypeError(`${currentPath} must be a closed dense array`);
        }
        const length = lengthDescriptor.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RECEIPT_JSON_NODES - state.nodes) {
          throw new TypeError(`${path} exceeds the JSON node limit`);
        }
        const indexDescriptors = new Map();
        for (const key of Reflect.ownKeys(current)) {
          if (key === 'length') continue;
          if (!isArrayIndexKey(key, length)) {
            throw new TypeError(`${currentPath} must be a closed dense array`);
          }
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError(`${currentPath}[${key}] must be an enumerable data property`);
          }
          indexDescriptors.set(Number(key), descriptor);
        }
        if (indexDescriptors.size !== length) {
          throw new TypeError(`${currentPath} must be a closed dense array`);
        }
        const output = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = indexDescriptors.get(index);
          if (!descriptor) throw new TypeError(`${currentPath} must be a closed dense array`);
          output.push(visit(descriptor.value, `${currentPath}[${index}]`, depth + 1));
        }
        return output;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${currentPath} must use a plain object`);
      }
      const output = Object.create(null);
      const ownKeys = Reflect.ownKeys(current);
      if (ownKeys.length > MAX_RECEIPT_JSON_NODES - state.nodes) {
        throw new TypeError(`${path} exceeds the JSON node limit`);
      }
      for (const key of ownKeys) {
        if (typeof key !== 'string') throw new TypeError(`${currentPath} contains a symbol property`);
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError(`${currentPath} contains a non-enumerable or accessor property`);
        }
        output[key] = visit(descriptor.value, `${currentPath}.<field>`, depth + 1);
      }
      return output;
    } finally {
      state.ancestors.delete(current);
    }
  }

  return visit(value, path, 0);
}

function collectReceiptPublicSafetyErrors(value, path, errors) {
  if (typeof value === 'string') {
    if (value.length > MAX_RECEIPT_PUBLIC_STRING_LENGTH) {
      errors.push(`${path} exceeds the public-safe string limit`);
    }
    if (/\u0000|[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
      errors.push(`${path} contains unsupported control characters`);
    }
    if (RECEIPT_SECRET_LIKE_PATTERNS.some((pattern) => pattern.test(value))) {
      errors.push(`${path} contains credential-like text`);
    }
    if (RECEIPT_PRIVATE_PATH_PATTERN.test(value)) {
      errors.push(`${path} contains a local or private path`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectReceiptPublicSafetyErrors(entry, `${path}[${index}]`, errors));
    return;
  }
  if (isPlainRecord(value)) {
    for (const key of Object.keys(value)) {
      collectReceiptPublicSafetyErrors(value[key], `${path}.<field>`, errors);
    }
  }
}

function responseById(messages, id) {
  return messages.find((message) => message?.type === 'response' && message.id === id);
}

function responseByCommand(messages, command, success) {
  return messages.find((message) => (
    message?.type === 'response'
    && message.command === command
    && message.success === success
  ));
}

function matrixCase(id, passed, summary) {
  return Object.freeze({ id, status: passed ? 'passed' : 'failed', summary });
}

export function evaluatePrimeAgentCompatibilityTranscript({ stdout, exitCode, signal = null, spawnError = null }) {
  const { messages, invalidLines, carriageReturnCount } = parseTranscript(stdout);
  const state = responseById(messages, 'state-1');
  const commands = responseById(messages, 'commands-1');
  const status = responseById(messages, 'status-1');
  const abort = responseById(messages, 'abort-1');
  const observe = responseById(messages, 'observe-1');
  const unobserve = responseById(messages, 'unobserve-1');
  const parseFailure = responseByCommand(messages, 'parse', false);
  const unknownFailure = responseByCommand(messages, 'agoragentic_unknown_probe', false);
  const notification = messages.find((message) => message?.type === 'extension_ui_request' && message.method === 'notify');
  let statusBody = null;
  try {
    statusBody = JSON.parse(notification?.message || 'null');
  } catch {
    statusBody = null;
  }
  const commandList = Array.isArray(commands?.data?.commands) ? commands.data.commands : [];
  const agoraCommand = commandList.find((command) => command?.name === 'agora-status');

  const matrix = Object.freeze([
    matrixCase('jsonl_lf_framing', invalidLines.length === 0 && carriageReturnCount === 0, PRIME_AGENT_COMPATIBILITY_CASE_SUMMARIES.jsonl_lf_framing),
    matrixCase('get_state', state?.success === true && state?.data?.isStreaming === false, PRIME_AGENT_COMPATIBILITY_CASE_SUMMARIES.get_state),
    matrixCase('extension_discovery', commands?.success === true && agoraCommand?.source === 'extension', PRIME_AGENT_COMPATIBILITY_CASE_SUMMARIES.extension_discovery),
    matrixCase('extension_command_load', status?.success === true && statusBody?.authority_granted_by_extension === false, PRIME_AGENT_COMPATIBILITY_CASE_SUMMARIES.extension_command_load),
    matrixCase('abort_idle', abort?.success === true, PRIME_AGENT_COMPATIBILITY_CASE_SUMMARIES.abort_idle),
    matrixCase('observe_missing', observe?.success === false && /Unknown active session/.test(observe?.error || ''), PRIME_AGENT_COMPATIBILITY_CASE_SUMMARIES.observe_missing),
    matrixCase('unobserve_missing', unobserve?.success === true, PRIME_AGENT_COMPATIBILITY_CASE_SUMMARIES.unobserve_missing),
    matrixCase('malformed_frame', parseFailure && /Failed to parse command/.test(parseFailure.error || ''), PRIME_AGENT_COMPATIBILITY_CASE_SUMMARIES.malformed_frame),
    matrixCase('unknown_command', unknownFailure && /Unknown command/.test(unknownFailure.error || ''), PRIME_AGENT_COMPATIBILITY_CASE_SUMMARIES.unknown_command),
    matrixCase('eof_shutdown', exitCode === 0 && signal === null && spawnError === null, PRIME_AGENT_COMPATIBILITY_CASE_SUMMARIES.eof_shutdown),
  ]);
  const matrixPassed = matrix.every((entry) => entry.status === 'passed');
  const result = Object.freeze({
    matrix,
    matrix_passed: matrixPassed,
    observed_rpc_commands: Object.freeze(PRIME_AGENT_REQUIRED_RPC_COMMANDS),
    message_count: messages.length,
    invalid_stdout_record_count: invalidLines.length,
    carriage_return_count: carriageReturnCount,
    extension_command_source: agoraCommand?.source || null,
    compatibility_process_exit_code: exitCode,
    compatibility_process_signal: signal,
  });
  return result;
}

export function runPrimeAgentReleasedCompatibility({
  artifactPath,
  releaseRoot,
  extensionPath,
  pinnedDependencyLockPath = resolve(dirnameFromModule(), 'evidence', 'prime-agent-v0.7.2-package-lock.json'),
  integrityProfilePath = resolve(dirnameFromModule(), 'evidence', 'prime-agent-v0.7.2-integrity-profile.v1.json'),
  timeoutMs = 30_000,
} = {}) {
  const releaseVerification = verifyPrimeAgentReleaseArtifact(artifactPath);
  const blockers = [...releaseVerification.blockers];
  const packageRoot = resolve(String(releaseRoot || ''));
  const extensionRoot = resolve(String(extensionPath || ''));
  const packageJsonPath = join(packageRoot, 'package.json');
  const cliPath = join(packageRoot, 'dist', 'bundle', 'cli.js');
  const extensionPackagePath = join(extensionRoot, 'package.json');
  const integrityProfile = loadPrimeAgentIntegrityProfile(integrityProfilePath);
  blockers.push(...integrityProfile.blockers);
  const selectedDependencyClosure = integrityProfile.valid
    ? selectPrimeAgentDependencyClosure(integrityProfile.profile, process.platform, process.arch)
    : null;
  if (integrityProfile.valid && !selectedDependencyClosure) {
    blockers.push(`integrity_profile:dependency_closure_missing:${process.platform}/${process.arch}`);
  }
  if (selectedDependencyClosure && selectedDependencyClosure.node_version !== process.version) {
    blockers.push('integrity_profile:node_version_mismatch');
  }
  if (
    integrityProfile.valid
    && integrityProfile.profile.host_release_asset_sha256 !== PRIME_AGENT_HOST_IDENTITY.release_asset_sha256
  ) blockers.push('integrity_profile:host_release_asset_sha256_mismatch');
  if (
    integrityProfile.valid
    && integrityProfile.profile.dependency_lock_digest !== PRIME_AGENT_HOST_CONTRACT.dependency_lock_sha256
  ) blockers.push('integrity_profile:dependency_lock_digest_mismatch');

  if (!existsSync(packageJsonPath) || !existsSync(cliPath)) blockers.push('materialized_release_root_invalid');
  if (!existsSync(extensionPackagePath)) blockers.push('extension_package_invalid');
  if (blockers.length === 0) {
    try {
      blockers.push(...validatePrimeAgentPackageMetadata(JSON.parse(readFileSync(packageJsonPath, 'utf8'))).blockers);
    } catch {
      blockers.push('materialized_package_metadata_invalid');
    }
  }

  const materializedFirstPartyIntegrity = buildTreeIntegrity(packageRoot, {
    excludeTopLevel: ['node_modules', 'package-lock.json', 'npm-shrinkwrap.json'],
  });
  blockers.push(...materializedFirstPartyIntegrity.blockers.map((blocker) => `materialized_release_tree:${blocker}`));
  if (
    materializedFirstPartyIntegrity.valid
    && releaseVerification.observed.first_party_tree_digest
    && (
      materializedFirstPartyIntegrity.tree_digest !== releaseVerification.observed.first_party_tree_digest
      || materializedFirstPartyIntegrity.file_count !== releaseVerification.observed.first_party_file_count
    )
  ) {
    blockers.push('materialized_release_tree_mismatch');
  }

  const dependencyIntegrity = buildPrimeAgentDependencyIntegrity(packageRoot, pinnedDependencyLockPath, {
    expectedClosure: selectedDependencyClosure,
  });
  blockers.push(...dependencyIntegrity.blockers);
  if (dependencyIntegrity.lock_digest !== PRIME_AGENT_HOST_CONTRACT.dependency_lock_sha256) {
    blockers.push('pinned_dependency_lock_contract_mismatch');
  }
  const extensionIntegrity = buildPrimeAgentExtensionIntegrity(extensionRoot, {
    expectedManifestDigest: integrityProfile.profile?.extension_manifest_digest || null,
  });
  blockers.push(...extensionIntegrity.blockers);

  let transcript = null;
  let stderrPresent = false;
  let compatibilityProcessExecuted = false;
  if (blockers.length === 0) {
    const runtimeHandle = createPrimeAgentCompatibilityRuntimeHandle();
    const runtimeRoot = runtimeHandle.runtime_root;
    const daemonSocketPath = runtimeHandle.daemon_socket;
    try {
      const input = [
        ...RPC_INPUT.map((entry) => JSON.stringify(entry)),
        'not-json',
        JSON.stringify({ id: 'unknown-1', type: 'agoragentic_unknown_probe' }),
        '',
      ].join('\n');
      const child = spawnSync(process.execPath, [
        cliPath,
        '--offline',
        '--mode',
        'rpc',
        '--daemon-socket',
        daemonSocketPath,
        '--no-session',
        '--no-builtin-tools',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--no-context-files',
        '-e',
        extensionRoot,
      ], {
        cwd: runtimeRoot,
        env: buildPrimeAgentSafeChildEnvironment(runtimeRoot),
        input,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      compatibilityProcessExecuted = true;
      stderrPresent = Boolean(child.stderr);
      transcript = evaluatePrimeAgentCompatibilityTranscript({
        stdout: child.stdout,
        exitCode: child.status,
        signal: child.signal,
        spawnError: child.error || null,
      });
      transcript = Object.freeze({
        ...transcript,
        stdout_digest: integritySha256(child.stdout || ''),
        stderr_digest: integritySha256(child.stderr || ''),
      });
      if (!transcript.matrix_passed) blockers.push('compatibility_matrix_failed');
      if (transcript.message_count !== PRIME_AGENT_EXPECTED_COMPATIBILITY_MESSAGE_COUNT) {
        blockers.push('compatibility_message_count_mismatch');
      }
      if (stderrPresent || transcript.stderr_digest !== EMPTY_OUTPUT_SHA256) {
        blockers.push('compatibility_stderr_observed');
      }
    } finally {
      const shutdownConfirmed = shutdownPrimeAgentDaemon(packageRoot, runtimeHandle);
      if (!shutdownConfirmed) {
        blockers.push('compatibility_daemon_cleanup_failed');
        blockers.push('compatibility_runtime_root_preserved_after_unconfirmed_exit');
      } else if (!finalizePrimeAgentRuntimeRoot(runtimeHandle, { shutdownConfirmed })) {
        blockers.push('compatibility_runtime_cleanup_failed');
      }
    }
  }

  const result = Object.freeze({
    schema: 'agoragentic.prime-agent.released-compatibility.v1',
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
    host_identity: PRIME_AGENT_HOST_IDENTITY,
    host_contract_hash: PRIME_AGENT_HOST_CONTRACT.contract_hash,
    integrity_profile: integrityProfile,
    release_verification: releaseVerification,
    materialized_first_party_integrity: materializedFirstPartyIntegrity,
    dependency_integrity: dependencyIntegrity,
    extension_integrity: extensionIntegrity,
    transcript,
    immutable_release_pin_verified: releaseVerification.valid,
    exact_host_artifact_loaded: Boolean(transcript?.matrix_passed),
    compatibility_matrix_passed: Boolean(transcript?.matrix_passed),
    compatibility_process_executed: compatibilityProcessExecuted,
    compatibility_process_stderr_present: stderrPresent,
    policy_boundary_observed: false,
    active_abort_observed: false,
    stale_worker_recovery_observed: false,
    restricted_exact_runtime_observed: false,
    runtime_verified: false,
    runtime_executed: false,
    exact_runtime_verified: false,
    hosted_available: false,
    production_activated: false,
    credentials_used: false,
    paid_provider_calls: false,
    network_authority_granted: false,
    spend_authorized: false,
    authority_granted: false,
    package_published: false,
    partnership_claimed: false,
    public_compatibility_claimed: false,
  });
  if (result.valid) {
    SUCCESSFUL_COMPATIBILITY_RESULTS.set(result, Object.freeze({
      observedAt: new Date().toISOString(),
    }));
  }
  return result;
}

export function createPrimeAgentCompatibilityReceipt(result, { observedAt } = {}) {
  if (!result?.valid) {
    throw new TypeError(`cannot create receipt for blocked compatibility run: ${(result?.blockers || []).join(', ')}`);
  }
  if (observedAt !== undefined && !isValidRfc3339Utc(observedAt)) {
    throw new TypeError('observedAt must be an RFC 3339 UTC timestamp');
  }
  if (
    result.release_verification?.valid !== true
    || result.materialized_first_party_integrity?.valid !== true
    || result.dependency_integrity?.valid !== true
    || result.extension_integrity?.valid !== true
    || result.integrity_profile?.valid !== true
    || result.transcript?.matrix_passed !== true
    || result.compatibility_process_executed !== true
  ) {
    throw new TypeError('compatibility result is incomplete');
  }
  if (result.transcript.message_count !== PRIME_AGENT_EXPECTED_COMPATIBILITY_MESSAGE_COUNT) {
    throw new TypeError('compatibility result does not have the exact expected message count');
  }
  if (
    result.compatibility_process_stderr_present !== false
    || result.transcript.stderr_digest !== EMPTY_OUTPUT_SHA256
  ) {
    throw new TypeError('compatibility result must bind empty stderr');
  }
  const provenance = SUCCESSFUL_COMPATIBILITY_RESULTS.get(result);
  if (!provenance) {
    throw new TypeError('compatibility result must come directly from the exact released compatibility runner');
  }
  if (observedAt !== undefined && observedAt !== provenance.observedAt) {
    throw new TypeError('observedAt must match the exact released compatibility runner observation time');
  }
  const receiptObservedAt = provenance.observedAt;
  const body = {
    schema: PRIME_AGENT_COMPATIBILITY_RECEIPT_SCHEMA,
    receipt_version: 1,
    integration_id: 'prime-agent-governance',
    observed_at: receiptObservedAt,
    platform: process.platform,
    architecture: process.arch,
    node_version: process.version,
    host_identity: PRIME_AGENT_HOST_IDENTITY,
    host_contract_hash: PRIME_AGENT_HOST_CONTRACT.contract_hash,
    integrity_profile_hash: result.integrity_profile.profile.profile_hash,
    artifact: {
      asset_name: result.release_verification.observed.asset_name,
      asset_size_bytes: result.release_verification.observed.asset_size_bytes,
      asset_sha256: `sha256:${result.release_verification.observed.asset_sha256}`,
      first_party_file_count: result.materialized_first_party_integrity.file_count,
      first_party_tree_digest: result.materialized_first_party_integrity.tree_digest,
    },
    dependency_closure: {
      lock_digest: result.dependency_integrity.lock_digest,
      dependency_file_count: result.dependency_integrity.dependency_file_count,
      dependency_tree_digest: result.dependency_integrity.dependency_tree_digest,
    },
    extension: {
      package_name: result.extension_integrity.package_name,
      package_version: result.extension_integrity.package_version,
      distribution_status: result.extension_integrity.distribution_status,
      manifest_digest: result.extension_integrity.manifest_digest,
    },
    compatibility: {
      process_executed: true,
      matrix_passed: true,
      matrix: result.transcript.matrix,
      matrix_digest: integritySha256(result.transcript.matrix),
      observed_rpc_commands: result.transcript.observed_rpc_commands,
      message_count: result.transcript.message_count,
      invalid_stdout_record_count: result.transcript.invalid_stdout_record_count,
      carriage_return_count: result.transcript.carriage_return_count,
      process_exit_code: result.transcript.compatibility_process_exit_code,
      process_signal: result.transcript.compatibility_process_signal,
      stdout_digest: result.transcript.stdout_digest,
      stderr_digest: result.transcript.stderr_digest,
      stderr_present: result.compatibility_process_stderr_present,
    },
    evidence_limits: {
      policy_boundary_observed: false,
      active_abort_observed: false,
      stale_worker_recovery_observed: false,
      restricted_exact_runtime_observed: false,
      runtime_verified: false,
      exact_runtime_verified: false,
      hosted_available: false,
      production_activated: false,
    },
    boundaries: Object.fromEntries(RECEIPT_BOUNDARY_KEYS.map((key) => [key, false])),
  };
  const receipt = Object.freeze({ ...body, receipt_hash: integritySha256(body) });
  const verification = verifyPrimeAgentCompatibilityReceipt(receipt);
  if (!verification.ok) {
    throw new TypeError(`compatibility receipt self-verification failed: ${verification.errors.join('; ')}`);
  }
  SUCCESSFUL_COMPATIBILITY_RESULTS.delete(result);
  return receipt;
}

function verifyPrimeAgentCompatibilityReceiptUnchecked(inputReceipt, {
  integrityProfilePath = resolve(dirnameFromModule(), 'evidence', 'prime-agent-v0.7.2-integrity-profile.v1.json'),
} = {}) {
  const errors = [];
  const integrityProfile = loadPrimeAgentIntegrityProfile(integrityProfilePath);
  if (!integrityProfile.valid) errors.push(...integrityProfile.blockers.map((blocker) => `receipt.${blocker}`));
  let receipt;
  try {
    receipt = snapshotClosedJsonValue(inputReceipt);
  } catch (error) {
    const message = error instanceof TypeError
      ? error.message
      : 'receipt could not be captured as closed JSON';
    errors.push(message);
    return Object.freeze({
      ok: false,
      errors: Object.freeze(errors),
      expected_hash: null,
    });
  }
  collectReceiptPublicSafetyErrors(receipt, 'receipt', errors);
  const isObject = isPlainRecord;
  const closedKeys = (value, path, keys) => {
    if (!isObject(value)) return;
    for (const key of keys) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !keys.includes(key)) errors.push(`${path} contains an unknown field`);
    }
  };
  const topLevelKeys = [
    'schema',
    'receipt_version',
    'integration_id',
    'observed_at',
    'platform',
    'architecture',
    'node_version',
    'host_identity',
    'host_contract_hash',
    'integrity_profile_hash',
    'artifact',
    'dependency_closure',
    'extension',
    'compatibility',
    'evidence_limits',
    'boundaries',
    'receipt_hash',
  ];
  if (!isObject(receipt)) return { ok: false, errors: ['receipt must be an object'] };
  closedKeys(receipt, 'receipt', topLevelKeys);
  if (receipt.schema !== PRIME_AGENT_COMPATIBILITY_RECEIPT_SCHEMA) errors.push('receipt.schema mismatch');
  if (receipt.receipt_version !== 1) errors.push('receipt.receipt_version must be 1');
  if (receipt.integration_id !== 'prime-agent-governance') errors.push('receipt.integration_id mismatch');
  if (
    typeof receipt.observed_at !== 'string'
    || !isValidRfc3339Utc(receipt.observed_at)
  ) errors.push('receipt.observed_at is invalid');
  for (const key of ['platform', 'architecture', 'node_version']) {
    if (typeof receipt[key] !== 'string' || receipt[key].length === 0 || receipt[key].length > 80) {
      errors.push(`receipt.${key} is invalid`);
    }
  }
  if (integritySha256(receipt.host_identity) !== integritySha256(PRIME_AGENT_HOST_IDENTITY)) {
    errors.push('receipt.host_identity mismatch');
  }
  if (receipt.host_contract_hash !== PRIME_AGENT_HOST_CONTRACT.contract_hash) {
    errors.push('receipt.host_contract_hash mismatch');
  }
  if (receipt.integrity_profile_hash !== integrityProfile.profile?.profile_hash) {
    errors.push('receipt.integrity_profile_hash mismatch');
  }
  if (!isObject(receipt.artifact)) {
    errors.push('receipt.artifact must be an object');
  } else {
    closedKeys(receipt.artifact, 'receipt.artifact', [
      'asset_name',
      'asset_size_bytes',
      'asset_sha256',
      'first_party_file_count',
      'first_party_tree_digest',
    ]);
    if (receipt.artifact.asset_name !== PRIME_AGENT_HOST_IDENTITY.release_asset) errors.push('receipt.artifact.asset_name mismatch');
    if (receipt.artifact.asset_size_bytes !== 9387295) errors.push('receipt.artifact.asset_size_bytes mismatch');
    if (receipt.artifact.asset_sha256 !== PRIME_AGENT_HOST_IDENTITY.release_asset_sha256) errors.push('receipt.artifact.asset_sha256 mismatch');
    if (receipt.artifact.asset_sha256 !== integrityProfile.profile?.host_release_asset_sha256) {
      errors.push('receipt.artifact.asset_sha256 does not match integrity profile');
    }
    if (!Number.isInteger(receipt.artifact.first_party_file_count) || receipt.artifact.first_party_file_count < 1) {
      errors.push('receipt.artifact.first_party_file_count is invalid');
    }
    if (!SHA256_PATTERN.test(receipt.artifact.first_party_tree_digest || '')) errors.push('receipt.artifact.first_party_tree_digest is invalid');
    if (
      receipt.artifact.first_party_file_count !== PRIME_AGENT_HOST_CONTRACT.release_first_party_file_count
      || receipt.artifact.first_party_tree_digest !== PRIME_AGENT_HOST_CONTRACT.release_first_party_tree_digest
    ) errors.push('receipt.artifact first-party tree mismatch');
  }
  if (!isObject(receipt.dependency_closure)) {
    errors.push('receipt.dependency_closure must be an object');
  } else {
    closedKeys(receipt.dependency_closure, 'receipt.dependency_closure', [
      'lock_digest',
      'dependency_file_count',
      'dependency_tree_digest',
    ]);
    if (!SHA256_PATTERN.test(receipt.dependency_closure.lock_digest || '')) errors.push('receipt.dependency_closure.lock_digest is invalid');
    if (receipt.dependency_closure.lock_digest !== PRIME_AGENT_HOST_CONTRACT.dependency_lock_sha256) {
      errors.push('receipt.dependency_closure.lock_digest mismatch');
    }
    if (receipt.dependency_closure.lock_digest !== integrityProfile.profile?.dependency_lock_digest) {
      errors.push('receipt.dependency_closure.lock_digest does not match integrity profile');
    }
    if (!Number.isInteger(receipt.dependency_closure.dependency_file_count) || receipt.dependency_closure.dependency_file_count < 1) {
      errors.push('receipt.dependency_closure.dependency_file_count is invalid');
    }
    if (!SHA256_PATTERN.test(receipt.dependency_closure.dependency_tree_digest || '')) {
      errors.push('receipt.dependency_closure.dependency_tree_digest is invalid');
    }
    const selectedDependencyClosure = selectPrimeAgentDependencyClosure(
      integrityProfile.profile,
      receipt.platform,
      receipt.architecture,
    );
    if (!selectedDependencyClosure) {
      errors.push('receipt.dependency_closure platform tuple is not pinned');
    } else if (
      receipt.dependency_closure.dependency_file_count !== selectedDependencyClosure.dependency_file_count
      || receipt.dependency_closure.dependency_tree_digest !== selectedDependencyClosure.dependency_tree_digest
    ) {
      errors.push('receipt.dependency_closure does not match integrity profile');
    }
    if (selectedDependencyClosure && receipt.node_version !== selectedDependencyClosure.node_version) {
      errors.push('receipt.node_version does not match integrity profile');
    }
  }
  if (!isObject(receipt.extension)) {
    errors.push('receipt.extension must be an object');
  } else {
    closedKeys(receipt.extension, 'receipt.extension', [
      'package_name',
      'package_version',
      'distribution_status',
      'manifest_digest',
    ]);
    if (receipt.extension.package_name !== '@agoragentic/prime-agent') errors.push('receipt.extension.package_name mismatch');
    if (receipt.extension.package_version !== '0.2.0-alpha.0') errors.push('receipt.extension.package_version mismatch');
    if (receipt.extension.distribution_status !== 'source_only') errors.push('receipt.extension.distribution_status mismatch');
    if (!SHA256_PATTERN.test(receipt.extension.manifest_digest || '')) errors.push('receipt.extension.manifest_digest is invalid');
    if (receipt.extension.manifest_digest !== integrityProfile.profile?.extension_manifest_digest) {
      errors.push('receipt.extension.manifest_digest does not match integrity profile');
    }
  }
  if (!isObject(receipt.compatibility)) {
    errors.push('receipt.compatibility must be an object');
  } else {
    closedKeys(receipt.compatibility, 'receipt.compatibility', [
      'process_executed',
      'matrix_passed',
      'matrix',
      'matrix_digest',
      'observed_rpc_commands',
      'message_count',
      'invalid_stdout_record_count',
      'carriage_return_count',
      'process_exit_code',
      'process_signal',
      'stdout_digest',
      'stderr_digest',
      'stderr_present',
    ]);
    const caseIds = Array.isArray(receipt.compatibility.matrix)
      ? receipt.compatibility.matrix.map((entry) => entry?.id)
      : [];
    if (receipt.compatibility.process_executed !== true) errors.push('receipt.compatibility.process_executed must be true');
    if (receipt.compatibility.matrix_passed !== true) errors.push('receipt.compatibility.matrix_passed must be true');
    if (JSON.stringify(caseIds) !== JSON.stringify(PRIME_AGENT_COMPATIBILITY_CASE_IDS)) {
      errors.push('receipt.compatibility.matrix cases mismatch');
    }
    if (!Array.isArray(receipt.compatibility.matrix)
      || receipt.compatibility.matrix.some((entry) => entry?.status !== 'passed')) {
      errors.push('receipt.compatibility.matrix must contain only passed cases');
    }
    if (Array.isArray(receipt.compatibility.matrix)) {
      for (const [index, entry] of receipt.compatibility.matrix.entries()) {
        closedKeys(entry, `receipt.compatibility.matrix[${index}]`, ['id', 'status', 'summary']);
        if (typeof entry?.summary !== 'string' || entry.summary.length === 0 || entry.summary.length > 500) {
          errors.push(`receipt.compatibility.matrix[${index}].summary is invalid`);
        }
      }
    }
    if (
      !Array.isArray(receipt.compatibility.matrix)
      || integritySha256(receipt.compatibility.matrix) !== integritySha256(PRIME_AGENT_EXPECTED_COMPATIBILITY_MATRIX)
    ) {
      errors.push('receipt.compatibility.matrix content mismatch');
    }
    if (receipt.compatibility.matrix_digest !== integritySha256(receipt.compatibility.matrix)) {
      errors.push('receipt.compatibility.matrix_digest mismatch');
    }
    for (const key of ['stdout_digest', 'stderr_digest']) {
      if (!SHA256_PATTERN.test(receipt.compatibility[key] || '')) errors.push(`receipt.compatibility.${key} is invalid`);
    }
    if (receipt.compatibility.process_exit_code !== 0 || receipt.compatibility.process_signal !== null) {
      errors.push('receipt.compatibility process did not exit cleanly');
    }
    if (receipt.compatibility.invalid_stdout_record_count !== 0) {
      errors.push('receipt.compatibility invalid stdout records observed');
    }
    if (receipt.compatibility.carriage_return_count !== 0) {
      errors.push('receipt.compatibility carriage returns observed');
    }
    if (JSON.stringify(receipt.compatibility.observed_rpc_commands) !== JSON.stringify(PRIME_AGENT_REQUIRED_RPC_COMMANDS)) {
      errors.push('receipt.compatibility.observed_rpc_commands mismatch');
    }
    if (receipt.compatibility.message_count !== PRIME_AGENT_EXPECTED_COMPATIBILITY_MESSAGE_COUNT) {
      errors.push('receipt.compatibility.message_count mismatch');
    }
    if (receipt.compatibility.stderr_present !== false) {
      errors.push('receipt.compatibility.stderr_present must be false');
    }
    if (receipt.compatibility.stderr_digest !== EMPTY_OUTPUT_SHA256) {
      errors.push('receipt.compatibility.stderr_digest must bind empty stderr');
    }
  }
  const requiredFalseLimits = [
    'policy_boundary_observed',
    'active_abort_observed',
    'stale_worker_recovery_observed',
    'restricted_exact_runtime_observed',
    'runtime_verified',
    'exact_runtime_verified',
    'hosted_available',
    'production_activated',
  ];
  if (!isObject(receipt.evidence_limits)) {
    errors.push('receipt.evidence_limits must be an object');
  } else {
    closedKeys(receipt.evidence_limits, 'receipt.evidence_limits', requiredFalseLimits);
    for (const key of requiredFalseLimits) {
      if (receipt.evidence_limits[key] !== false) errors.push(`receipt.evidence_limits.${key} must be false`);
    }
  }
  if (!isObject(receipt.boundaries)) {
    errors.push('receipt.boundaries must be an object');
  } else {
    closedKeys(receipt.boundaries, 'receipt.boundaries', RECEIPT_BOUNDARY_KEYS);
    for (const key of RECEIPT_BOUNDARY_KEYS) {
      if (receipt.boundaries[key] !== false) errors.push(`receipt.boundaries.${key} must be false`);
    }
  }
  const { receipt_hash: observedHash, ...body } = receipt;
  const expectedHash = integritySha256(body);
  if (!SHA256_PATTERN.test(observedHash || '') || observedHash !== expectedHash) errors.push('receipt.receipt_hash mismatch');
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors), expected_hash: expectedHash });
}

export function verifyPrimeAgentCompatibilityReceipt(inputReceipt, options = {}) {
  try {
    return verifyPrimeAgentCompatibilityReceiptUnchecked(inputReceipt, options);
  } catch {
    return Object.freeze({
      ok: false,
      errors: Object.freeze(['receipt verification could not complete for the supplied shape']),
      expected_hash: null,
    });
  }
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] || null;
}

function main() {
  const argv = process.argv.slice(2);
  const artifactPath = argument(argv, '--artifact') || process.env.PRIME_AGENT_V072_TGZ;
  const releaseRoot = argument(argv, '--release-root') || process.env.PRIME_AGENT_V072_ROOT;
  const extensionPath = argument(argv, '--extension') || dirnameFromModule();
  const pinnedDependencyLockPath = argument(argv, '--dependency-lock')
    || resolve(dirnameFromModule(), 'evidence', 'prime-agent-v0.7.2-package-lock.json');
  const integrityProfilePath = argument(argv, '--integrity-profile')
    || resolve(dirnameFromModule(), 'evidence', 'prime-agent-v0.7.2-integrity-profile.v1.json');
  const receiptPath = argument(argv, '--write-receipt');
  if (!artifactPath || !releaseRoot) {
    console.error('Usage: node compatibility-runner.mjs --artifact <tgz> --release-root <installed package> [--dependency-lock <lock>] [--extension <package>] [--write-receipt <json>]');
    process.exitCode = 2;
    return;
  }
  const result = runPrimeAgentReleasedCompatibility({
    artifactPath,
    releaseRoot,
    extensionPath,
    pinnedDependencyLockPath,
    integrityProfilePath,
  });
  if (receiptPath) {
    const receipt = createPrimeAgentCompatibilityReceipt(result);
    writeFileSync(resolve(receiptPath), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
}

function dirnameFromModule() {
  return resolve(fileURLToPath(new URL('.', import.meta.url)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
