import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { canonicalize } from './canonical.mjs';
import {
  assertAllowedKeys, assertPlainObject, boundedInteger, requireSha256Ref, requireString,
} from './util.mjs';

const BOUNDARIES = new WeakSet();
const FRAME_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_PROCESSES = 8;
const EFFECTFUL_OPERATIONS = new Set(['create', 'kill', 'write_commit', 'file_remove', 'child_kill', 'set_timeout', 'command_run']);
let retainedProcesses = 0;

function failure(code = 'E2B_SDK_PROCESS_OUTCOME_UNKNOWN') {
  const error = new Error('E2B SDK process boundary failed; provider outcome is not established');
  error.name = 'E2BSdkProcessBoundaryError';
  error.code = code;
  error.retryable = false;
  error.production_qualified = false;
  error.provider_outcome = 'unknown';
  return error;
}

// Serialized into a fresh Node process as well as run by its clean parent.
// Keep this function self-contained: no ambient imports, closures or test seams.
async function checkReadonlyCustody(config, runtimeFiles = []) {
  const fs = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const crypto = await import('node:crypto');
  const posix = (await import('node:path')).posix;
  if (process.platform !== 'linux' || typeof process.getuid !== 'function'
    || process.getuid() === 0 || process.getgid() === 0) throw new Error('unsupported custody');
  const status = await fs.readFile('/proc/self/status', 'utf8');
  for (const key of ['CapEff', 'CapPrm', 'CapAmb']) {
    if (!new RegExp(`^${key}:\\s+0+$`, 'm').test(status)) throw new Error('capability custody');
  }
  if (!/^NoNewPrivs:\s+1$/m.test(status) || process.getgroups().includes(0)) {
    throw new Error('privilege custody');
  }
  const mounts = (await fs.readFile('/proc/self/mountinfo', 'utf8')).trim().split('\n').map((line) => {
    const fields = line.split(' ');
    if (fields.length < 10 || !fields.includes('-')) throw new Error('mount observation');
    const mount = fields[4].replace(/\\([0-7]{3})/g, (_, value) => String.fromCharCode(parseInt(value, 8)));
    return { mount, readonly: fields[5].split(',').includes('ro') };
  });
  for (const entry of [config.runtimeArtifactPath, config.packageDirectory, config.nodePath, ...runtimeFiles]) {
    if (!posix.isAbsolute(entry) || await fs.realpath(entry) !== entry) throw new Error('canonical custody');
    const applicable = mounts.filter(({ mount }) => entry === mount || entry.startsWith(mount === '/' ? '/' : `${mount}/`))
      .sort((left, right) => right.mount.length - left.mount.length);
    if (!applicable[0]?.readonly) throw new Error('writable custody');
  }
  const hash = async (file, expected) => {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > 512 * 1024 * 1024) throw new Error('artifact custody');
      const digest = crypto.createHash('sha256');
      const buffer = Buffer.alloc(256 * 1024);
      let total = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > before.size) throw new Error('artifact drift');
        digest.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      const named = await fs.lstat(file);
      if (total !== before.size || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino
        || `sha256:${digest.digest('hex')}` !== expected) throw new Error('artifact pin');
    } finally { await handle.close(); }
  };
  await hash(config.runtimeArtifactPath, config.runtimeArtifactHash);
  await hash(config.nodePath, config.nodeArtifactHash);
  if (process.execPath !== config.nodePath) throw new Error('runtime identity');
  return { uid: process.getuid(), gid: process.getgid(), readonly: true };
}

// Internal composition helper; checking a mount is not creating one. The
// actual installation and fresh launch must have these host-owned properties.
export async function assertE2BRuntimeSdkReadonlyCustody(profile, runtimeFiles) {
  return checkReadonlyCustody(profile, runtimeFiles);
}

// Only trusted SDK objects live in this process. The protocol never accepts
// property paths, arbitrary callbacks, eval text or an alternate SDK loader.
async function sdkProcessMain(checkCustody) {
  const crypto = await import('node:crypto');
  const { pathToFileURL } = await import('node:url');
  const LIMIT = 2 * 1024 * 1024;
  const CHUNK = 64 * 1024;
  const WRITE_LIMIT = 32 * 1024 * 1024;
  const READ_LIMIT = 4 * 1024 * 1024;
  const frame = Buffer.alloc(LIMIT);
  let used = 0;
  let initialized = false;
  let verifier;
  let binding;
  let sdk;
  let Sandbox;
  let inflight = 0;
  let creating = 0;
  let openingReads = 0;
  let sequence = 0;
  let writeBytes = 0;
  const children = new Map();
  const lists = new Map();
  const writes = new Map();
  const reads = new Map();
  const mutations = new WeakSet();
  const retiring = new WeakSet();
  class ReadRetired extends Error {}
  const send = (value) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (bytes.length > LIMIT) throw new Error('output bound');
    process.stdout.write(bytes);
  };
  const closed = (value, keys) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('closed wire');
  };
  const string = (value, max = 500) => {
    if (typeof value !== 'string' || !value.length || value.length > max || /[\0\r\n]/.test(value)) throw new Error('string bound');
    return value;
  };
  const integer = (value, max, min = 0) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('integer bound');
    return value;
  };
  const plain = (value, depth = 0, count = { value: 0 }) => {
    if (++count.value > 8_192 || depth > 20) throw new Error('data bound');
    if (value instanceof Date) return value.toISOString();
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
      if (typeof value === 'string' && Buffer.byteLength(value) > 128 * 1024) throw new Error('text bound');
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      if (value.length > 1_000) throw new Error('array bound');
      return value.map((entry) => plain(entry, depth + 1, count));
    }
    if (!value || typeof value !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new Error('data shape');
    const output = Object.create(null);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('data descriptor');
      output[key] = plain(descriptor.value, depth + 1, count);
    }
    return output;
  };
  const info = (value) => {
    const result = Object.create(null);
    for (const key of ['sandboxId', 'sandboxID', 'templateId', 'templateID', 'metadata', 'state',
      'allowInternetAccess', 'network', 'lifecycle', 'volumeMounts', 'startedAt', 'endAt']) {
      if (Object.hasOwn(value, key)) result[key] = plain(value[key]);
    }
    string(result.sandboxId ?? result.sandboxID);
    string(result.templateId ?? result.templateID);
    return result;
  };
  const child = (handle) => {
    const value = children.get(string(handle));
    if (!value) throw new Error('unknown child handle');
    return value;
  };
  const base64 = (value) => {
    if (typeof value !== 'string' || value.length > 4 * Math.ceil(CHUNK / 3)) throw new Error('binary bound');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length > CHUNK || bytes.toString('base64') !== value) throw new Error('binary encoding');
    return bytes;
  };
  const mutate = async (value, enter, action) => {
    if (mutations.has(value) || retiring.has(value)) throw new Error('child mutation already entered or retired');
    mutations.add(value);
    try {
      enter(); const result = await action();
      if (retiring.has(value)) throw new Error('effect completed after retirement began');
      return result;
    }
    finally { mutations.delete(value); }
  };
  const retireChild = (value) => {
    for (const [handle, owned] of children) if (owned === value) children.delete(handle);
    for (const [handle, entry] of writes) if (entry.child === value) {
      writes.delete(handle); writeBytes -= entry.bytes.length;
    }
    for (const [handle, entry] of reads) if (entry.child === value) {
      reads.delete(handle); entry.cancelled = true; entry.controller.abort();
      void entry.reader.cancel().catch(() => {});
    }
  };
  const dispatch = async (operation, args, enter) => {
    if (operation === 'load') {
      closed(args, ['expected']);
      if (sdk) {
        if (JSON.stringify(args.expected) !== JSON.stringify(binding)) throw new Error('loaded binding');
      } else {
        const loaded = await verifier.load(args.expected);
        sdk = loaded.module;
        Sandbox = sdk.Sandbox ?? sdk.default?.Sandbox ?? sdk.default;
        if (typeof Sandbox !== 'function' || ['create', 'getInfo', 'list', 'kill'].some((key) => typeof Sandbox[key] !== 'function')) throw new Error('SDK contract');
      }
      return { binding };
    }
    if (!sdk) throw new Error('SDK not loaded');
    if (operation === 'create') {
      closed(args, ['template', 'options']);
      string(args.template);
      closed(args.options, ['timeoutMs', 'secure', 'allowInternetAccess', 'network', 'lifecycle', 'metadata', 'envs', 'iam', 'volumeMounts']);
      if (children.size + creating >= 32) throw new Error('child capacity');
      plain(args.options);
      creating += 1;
      let value;
      try { enter(); value = await Sandbox.create(args.template, args.options); }
      finally { creating -= 1; }
      const sandboxId = string(value?.sandboxId);
      const handle = crypto.randomUUID();
      children.set(handle, value);
      return { handle, sandboxId };
    }
    if (operation === 'get_info' || operation === 'kill') {
      closed(args, ['sandboxId']);
      string(args.sandboxId);
      enter();
      if (operation === 'get_info') return info(await Sandbox.getInfo(args.sandboxId));
      for (const value of children.values()) if (value.sandboxId === args.sandboxId) retiring.add(value);
      const acknowledged = (await Sandbox.kill(args.sandboxId)) === true;
      if (acknowledged) for (const value of children.values()) {
        if (value.sandboxId === args.sandboxId) retireChild(value);
      }
      return { acknowledged };
    }
    if (operation === 'list_open') {
      closed(args, ['options']);
      closed(args.options, ['query']);
      closed(args.options.query, ['state', 'metadata']);
      plain(args.options);
      if (lists.size >= 32) throw new Error('list capacity');
      const paginator = Sandbox.list(args.options);
      if (typeof paginator?.nextItems !== 'function' || typeof paginator.hasNext !== 'boolean') throw new Error('list contract');
      const handle = crypto.randomUUID();
      if (paginator.hasNext) lists.set(handle, { paginator, pages: 0, busy: false });
      return { handle, hasNext: paginator.hasNext };
    }
    if (operation === 'list_close') {
      closed(args, ['handle']); string(args.handle); lists.delete(args.handle);
      return { completed: true };
    }
    if (operation === 'list_next') {
      closed(args, ['handle']);
      const entry = lists.get(string(args.handle));
      if (!entry || entry.busy || ++entry.pages > 100) throw new Error('list state');
      entry.busy = true;
      try {
        enter();
        const items = await entry.paginator.nextItems();
        if (!Array.isArray(items) || items.length > 1_000 || typeof entry.paginator.hasNext !== 'boolean') throw new Error('list bound');
        const hasNext = entry.paginator.hasNext;
        const result = { items: items.map(info), hasNext };
        if (!hasNext) lists.delete(args.handle);
        return result;
      } finally { entry.busy = false; }
    }
    if (operation === 'write_begin') {
      closed(args, ['handle', 'path', 'size', 'hash']);
      child(args.handle);
      string(args.path, 4_096);
      integer(args.size, WRITE_LIMIT);
      if (!/^sha256:[a-f0-9]{64}$/.test(args.hash) || writes.size >= 8 || writeBytes + args.size > WRITE_LIMIT) throw new Error('write capacity');
      const handle = crypto.randomUUID();
      writes.set(handle, { child: child(args.handle), path: args.path, bytes: Buffer.alloc(args.size), hash: args.hash, used: 0 });
      writeBytes += args.size;
      return { handle };
    }
    if (operation === 'write_chunk') {
      closed(args, ['handle', 'offset', 'bytes']);
      const entry = writes.get(string(args.handle));
      const bytes = base64(args.bytes);
      if (!entry || args.offset !== entry.used || bytes.length > entry.bytes.length - entry.used) throw new Error('write state');
      bytes.copy(entry.bytes, entry.used);
      entry.used += bytes.length;
      return { accepted: bytes.length };
    }
    if (operation === 'write_abort') {
      closed(args, ['handle']);
      const entry = writes.get(string(args.handle));
      if (entry) { writes.delete(args.handle); writeBytes -= entry.bytes.length; }
      return { completed: true };
    }
    if (operation === 'write_commit') {
      closed(args, ['handle']);
      const entry = writes.get(string(args.handle));
      if (!entry || entry.used !== entry.bytes.length || `sha256:${crypto.createHash('sha256').update(entry.bytes).digest('hex')}` !== entry.hash) throw new Error('write integrity');
      return mutate(entry.child, enter, async () => {
        writes.delete(args.handle);
        try { await entry.child.files.write(entry.path, entry.bytes); return { completed: true }; }
        finally { writeBytes -= entry.bytes.length; }
      });
    }
    if (operation === 'file_remove' || operation === 'child_kill' || operation === 'set_timeout' || operation === 'command_run') {
      const keys = { file_remove: ['handle', 'path'], child_kill: ['handle'], set_timeout: ['handle', 'timeoutMs'], command_run: ['handle', 'command', 'timeoutMs'] };
      closed(args, keys[operation]);
      const value = child(args.handle);
      if (operation === 'file_remove') {
        const target = string(args.path, 4_096);
        return mutate(value, enter, async () => { await value.files.remove(target); return { completed: true }; });
      }
      // Emergency kill must not wait behind a hung command. Its acknowledgement
      // retires only this local capability, never attests remote absence.
      if (operation === 'child_kill') {
        retiring.add(value);
        enter(); const acknowledged = (await value.kill()) === true;
        if (acknowledged) retireChild(value);
        return { acknowledged };
      }
      integer(args.timeoutMs, 10 * 60 * 1_000, 1);
      if (operation === 'set_timeout') return mutate(value, enter, async () => { await value.setTimeout(args.timeoutMs); return { completed: true }; });
      const command = string(args.command, 8_192);
      return mutate(value, enter, async () => {
        const result = await value.commands.run(command, { timeoutMs: args.timeoutMs });
        integer(result?.exitCode, 255);
        // An SDK error field must not be erased into a successful exit code.
        if (result.error != null || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
          || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 128 * 1024) throw new Error('command output bound');
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      });
    }
    if (operation === 'read_open') {
      closed(args, ['handle', 'path', 'timeoutMs', 'idleTimeoutMs']);
      if (reads.size + openingReads >= 8) throw new Error('reader capacity');
      integer(args.timeoutMs, 10 * 60 * 1_000, 1);
      integer(args.idleTimeoutMs, 10 * 60 * 1_000, 1);
      const controller = new AbortController();
      const value = child(args.handle); const target = string(args.path, 4_096);
      openingReads += 1;
      let stream;
      try {
        enter(); stream = await value.files.read(target, {
          format: 'stream', requestTimeoutMs: args.timeoutMs, streamIdleTimeoutMs: args.idleTimeoutMs, signal: controller.signal,
        });
      } finally { openingReads -= 1; }
      const reader = stream.getReader();
      const handle = crypto.randomUUID();
      reads.set(handle, { child: value, reader, controller, pending: null, offset: 0, bytes: 0, busy: false, cancelled: false });
      return { handle };
    }
    if (operation === 'read_next' || operation === 'read_cancel') {
      closed(args, ['handle']);
      const entry = reads.get(string(args.handle));
      if (!entry) {
        if (operation === 'read_cancel') return { completed: true };
        throw new Error('reader state');
      }
      if (operation === 'read_cancel') {
        reads.delete(args.handle); entry.cancelled = true; entry.controller.abort();
        // Cancellation is allowed while read_next is pending. Failure or a
        // hung cancellation retires the process through the caller deadline.
        await entry.reader.cancel(); return { completed: true };
      }
      if (entry.busy) throw new Error('reader state');
      entry.busy = true;
      try {
        while (!entry.pending || entry.offset === entry.pending.length) {
          const next = await entry.reader.read();
          if (entry.cancelled) throw new ReadRetired();
          if (next.done === true) { reads.delete(args.handle); return { done: true, bytes: '' }; }
          if (!(next.value instanceof Uint8Array) || next.value.byteLength > READ_LIMIT - entry.bytes) throw new Error('read bound');
          entry.bytes += next.value.byteLength;
          entry.pending = Buffer.from(next.value); entry.offset = 0;
        }
        const end = Math.min(entry.offset + CHUNK, entry.pending.length);
        const bytes = entry.pending.subarray(entry.offset, end).toString('base64');
        entry.offset = end;
        return { done: false, bytes };
      } catch (error) {
        reads.delete(args.handle); entry.controller.abort();
        // Release of a failed reader is bounded by process retirement, not a
        // fabricated successful provider cleanup.
        void entry.reader.cancel().catch(() => {});
        throw error;
      } finally { entry.busy = false; }
    }
    throw new Error('unsupported operation');
  };
  const accept = async (message) => {
    if (!initialized) {
      initialized = true;
      closed(message, ['config', 'nonce']);
      const config = message.config;
      closed(config, ['runtimeArtifactPath', 'runtimeArtifactHash', 'packageDirectory', 'nodePath', 'nodeArtifactHash', 'lifetimeMs']);
      const custody = await checkCustody(config);
      const runtime = await import(pathToFileURL(config.runtimeArtifactPath).href);
      verifier = runtime.createE2BRuntimeSdkIntegrityVerifier({ packageDirectory: config.packageDirectory,
        readOnlyRuntime: { runtimeArtifactPath: config.runtimeArtifactPath,
          runtimeArtifactHash: config.runtimeArtifactHash, nodeArtifactHash: config.nodeArtifactHash } });
      binding = await verifier.inspect();
      setTimeout(() => process.exit(1), integer(config.lifetimeMs, 10 * 60 * 1_000, 1_000));
      send({ id: 0, result: { binding, pid: process.pid, nonce: message.nonce, custody } });
      return;
    }
    closed(message, ['id', 'operation', 'args']);
    if (!verifier || message.id !== ++sequence || inflight >= 4) throw new Error('request state');
    string(message.operation, 64);
    inflight += 1;
    let entered = false;
    try { send({ id: message.id, result: await dispatch(message.operation, message.args, () => { entered = true; }) }); }
    catch (error) {
      let kind = entered ? 'unknown' : 'not_entered';
      if (error instanceof ReadRetired) kind = 'read_retired';
      if (message.operation === 'get_info' && typeof sdk?.SandboxNotFoundError === 'function' && error instanceof sdk.SandboxNotFoundError) kind = 'sandbox_not_found';
      if (['read_open', 'file_remove'].includes(message.operation) && typeof sdk?.FileNotFoundError === 'function' && error instanceof sdk.FileNotFoundError) kind = 'file_not_found';
      send({ id: message.id, error: kind });
    } finally { inflight -= 1; }
  };
  process.stdin.on('data', (chunk) => {
    for (const byte of chunk) {
      if (byte === 10) {
        const message = JSON.parse(frame.subarray(0, used).toString('utf8'));
        used = 0;
        void accept(message).catch(() => process.exit(1));
      } else {
        if (used >= LIMIT) process.exit(1);
        frame[used++] = byte;
      }
    }
  });
  process.stdin.on('end', () => process.exit(1));
}

export function isE2BRuntimeSdkProcessBoundary(value) { return BOUNDARIES.has(value); }

/** Host-owned SDK process, NOT a sandbox for untrusted code or activation grant. */
export function createE2BRuntimeSdkProcessBoundary(options = {}) {
  assertPlainObject(options, 'SDK process options');
  assertAllowedKeys(options, ['runtimeArtifactPath', 'runtimeArtifactHash', 'packageDirectory', 'nodeArtifactHash', 'providerApiKey', 'deadlineMs', 'lifetimeMs'], 'SDK process options');
  const absolute = (value, field) => {
    const result = requireString(value, field);
    if (!path.isAbsolute(result) || result !== path.resolve(result)) throw new TypeError(`${field} must be canonical absolute`);
    return result;
  };
  const config = Object.freeze({
    runtimeArtifactPath: absolute(options.runtimeArtifactPath, 'runtimeArtifactPath'),
    runtimeArtifactHash: requireSha256Ref(options.runtimeArtifactHash, 'runtimeArtifactHash'),
    packageDirectory: absolute(options.packageDirectory, 'packageDirectory'),
    nodePath: process.execPath,
    nodeArtifactHash: requireSha256Ref(options.nodeArtifactHash, 'nodeArtifactHash'),
    lifetimeMs: boundedInteger(options.lifetimeMs ?? 300_000, 'lifetimeMs', { min: 1_000, max: 600_000 }),
  });
  const deadlineMs = boundedInteger(options.deadlineMs ?? 30_000, 'deadlineMs', { min: 100, max: 600_000 });
  const env = Object.create(null);
  if (options.providerApiKey != null) env['E2B_API_KEY'] = requireString(options.providerApiKey, 'providerApiKey', {
    maxLength: 8_192, pattern: /^[\x21-\x7e]+$/,
  });
  let child;
  let startup;
  let loaded;
  let pin;
  let retired = false;
  let exited = false;
  let sequence = 0;
  let exitPromise;
  const metrics = {
    requests_started: 0, requests_completed: 0, requests_rejected_before_sdk: 0,
    effectful_outcomes_unknown: 0, request_deadlines_exceeded: 0,
    process_starts: 0, process_exits_observed: 0,
  };
  const pending = new Map();
  const terminate = () => {
    retired = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      if (EFFECTFUL_OPERATIONS.has(entry.operation)) metrics.effectful_outcomes_unknown += 1;
      entry.reject(failure());
    }
    pending.clear();
    if (child && !exited && child.exitCode === null && child.signalCode === null) {
      // Own a fresh Linux process group. This is a best-effort group kill, not
      // proof against setsid descendants; the host must own the full cgroup.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Not proof of group absence. */ }
      try { child.kill('SIGKILL'); } catch { /* Not proof of process exit. */ }
    }
  };
  const request = (operation, args, timeoutMs = deadlineMs) => {
    if (retired || !child || exited || pending.size >= 4) return Promise.reject(failure());
    const id = sequence + 1;
    const bytes = Buffer.from(`${canonicalize({ id, operation, args })}\n`);
    if (bytes.length > FRAME_BYTES) return Promise.reject(failure());
    sequence = id;
    metrics.requests_started += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { metrics.request_deadlines_exceeded += 1; terminate(); reject(failure()); }, timeoutMs);
      pending.set(id, { resolve, reject, timer, operation });
      child.stdin.write(bytes, (error) => { if (error) terminate(); });
    });
  };
  const start = async () => {
    if (retired) throw failure();
    if (startup) return startup;
    startup = (async () => {
      try { await checkReadonlyCustody(config); }
      catch { throw failure('E2B_SDK_PROCESS_PROFILE_UNVERIFIED'); }
      if (retired || retainedProcesses >= MAX_PROCESSES) throw failure();
      retainedProcesses += 1;
      const source = `(${sdkProcessMain.toString()})(${checkReadonlyCustody.toString()}).catch(() => process.exit(1));`;
      try {
        child = spawn(config.nodePath, ['--max-old-space-size=256', '--input-type=module', '--eval', source], {
          cwd: path.dirname(config.runtimeArtifactPath), env, shell: false, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch { retainedProcesses -= 1; throw failure(); }
      child.once('spawn', () => { metrics.process_starts += 1; });
      const frame = Buffer.alloc(FRAME_BYTES);
      let used = 0;
      let diagnosticBytes = 0;
      exitPromise = new Promise((resolve) => {
        child.once('close', () => {
          exited = true;
          if (Number.isSafeInteger(child.pid)) metrics.process_exits_observed += 1;
          retainedProcesses -= 1; terminate(); resolve();
        });
      });
      child.once('error', terminate);
      child.stdin.on('error', terminate);
      child.stdout.on('data', (chunk) => {
        try {
          for (const byte of chunk) {
            if (byte !== 10) { if (used >= FRAME_BYTES) throw failure(); frame[used++] = byte; continue; }
            const value = JSON.parse(frame.subarray(0, used).toString('utf8')); used = 0;
            assertPlainObject(value, 'SDK response');
            assertAllowedKeys(value, ['id', 'result', 'error'], 'SDK response');
            const entry = pending.get(value.id);
            if (!entry || Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error')) throw failure();
            pending.delete(value.id); clearTimeout(entry.timer);
            if (value.error) {
              if (value.error === 'sandbox_not_found' && entry.operation === 'get_info') {
                const error = failure(); error.name = 'SandboxNotFoundError'; error.code = 'SANDBOX_NOT_FOUND'; entry.reject(error);
              } else if (value.error === 'file_not_found' && ['read_open', 'file_remove'].includes(entry.operation)) {
                const error = failure(); error.name = 'FileNotFoundError'; error.code = 'ENOENT'; entry.reject(error);
              } else if (value.error === 'not_entered') {
                metrics.requests_rejected_before_sdk += 1;
                entry.reject(failure('E2B_SDK_PROCESS_NOT_ENTERED'));
              }
              else if (value.error === 'read_retired' && entry.operation === 'read_next') entry.reject(failure('E2B_SDK_PROCESS_READ_RETIRED'));
              else {
                if (EFFECTFUL_OPERATIONS.has(entry.operation)) metrics.effectful_outcomes_unknown += 1;
                entry.reject(failure());
                if (EFFECTFUL_OPERATIONS.has(entry.operation) || entry.operation === 'load') terminate();
              }
            } else { if (value.id !== 0) metrics.requests_completed += 1; entry.resolve(value.result); }
          }
        } catch { terminate(); }
      });
      child.stderr.on('data', (chunk) => { diagnosticBytes += chunk.length; if (diagnosticBytes > 32 * 1024) terminate(); });
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { terminate(); reject(failure()); }, deadlineMs);
        pending.set(0, { resolve, reject, timer, operation: 'inspect' });
      });
      const nonce = randomUUID();
      child.stdin.write(`${canonicalize({ config, nonce })}\n`);
      const observed = await ready;
      assertPlainObject(observed, 'SDK startup');
      assertAllowedKeys(observed, ['binding', 'pid', 'nonce', 'custody'], 'SDK startup');
      if (observed.pid !== child.pid || observed.nonce !== nonce || observed.custody?.readonly !== true
        || observed.custody.uid !== process.getuid() || observed.custody.gid !== process.getgid()) throw failure();
      assertPlainObject(observed.binding, 'SDK binding');
      assertAllowedKeys(observed.binding, ['package', 'version', 'integrity_hash'], 'SDK binding');
      if (observed.binding.package !== 'e2b' || observed.binding.version !== '2.39.0') throw failure();
      requireSha256Ref(observed.binding.integrity_hash, 'SDK integrity hash');
      pin = Object.freeze({ ...observed.binding });
      return pin;
    })().catch((error) => { terminate(); throw error; });
    return startup;
  };
  const expect = (value, keys) => { assertPlainObject(value, 'SDK result'); assertAllowedKeys(value, keys, 'SDK result'); return value; };
  const handle = (value) => requireString(value, 'SDK handle', { maxLength: 100, pattern: /^[a-f0-9-]{36}$/ });
  const bytes = (value) => {
    if (typeof value !== 'string' || value.length > 4 * Math.ceil(CHUNK_BYTES / 3)) throw failure();
    const result = Buffer.from(value, 'base64');
    if (result.length > CHUNK_BYTES || result.toString('base64') !== value) throw failure();
    return result;
  };
  const sandboxFacade = (record) => {
    expect(record, ['handle', 'sandboxId']);
    const owned = handle(record.handle);
    const sandboxId = requireString(record.sandboxId, 'sandboxId', { maxLength: 500 });
    const files = Object.freeze({
      async write(target, content) {
        requireString(target, 'file path');
        if (typeof content !== 'string' && !(content instanceof Uint8Array)) throw new TypeError('SDK write requires text or bytes');
        const data = Buffer.from(content);
        if (data.length > 32 * 1024 * 1024) throw new TypeError('SDK file write exceeds 32 MiB');
        const begun = expect(await request('write_begin', { handle: owned, path: target, size: data.length, hash: `sha256:${createHash('sha256').update(data).digest('hex')}` }), ['handle']);
        const write = handle(begun.handle);
        try {
        for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
          const chunk = data.subarray(offset, offset + CHUNK_BYTES);
          const accepted = expect(await request('write_chunk', { handle: write, offset, bytes: chunk.toString('base64') }), ['accepted']);
          if (accepted.accepted !== chunk.length) { terminate(); throw failure(); }
        }
        const result = expect(await request('write_commit', { handle: write }), ['completed']);
        if (result.completed !== true) { terminate(); throw failure(); }
        } finally {
          // The worker releases a committed buffer only after the actual SDK
          // call settles; this cancels only an uncommitted private transfer.
          if (!retired) await request('write_abort', { handle: write }).catch(() => { terminate(); });
        }
      },
      async remove(target) { requireString(target, 'file path'); await request('file_remove', { handle: owned, path: target }); },
      async read(target, readOptions = {}) {
        requireString(target, 'file path');
        assertPlainObject(readOptions, 'SDK read options');
        assertAllowedKeys(readOptions, ['format', 'requestTimeoutMs', 'streamIdleTimeoutMs', 'signal'], 'SDK read options');
        if (readOptions.format !== 'stream') throw new TypeError('SDK process files.read requires stream format');
        const total = boundedInteger(readOptions.requestTimeoutMs ?? deadlineMs, 'read deadline', { min: 1, max: 600_000 });
        const idle = boundedInteger(readOptions.streamIdleTimeoutMs ?? total, 'read idle deadline', { min: 1, max: total });
        if (readOptions.signal != null && !(readOptions.signal instanceof AbortSignal)) throw new TypeError('SDK read signal must be an AbortSignal');
        if (readOptions.signal?.aborted) throw failure();
        const opened = expect(await request('read_open', { handle: owned, path: target, timeoutMs: total, idleTimeoutMs: idle }, total), ['handle']);
        const reader = handle(opened.handle);
        let ended = false;
        let received = 0;
        let controller;
        const detach = () => readOptions.signal?.removeEventListener('abort', abort);
        const abort = () => { if (!ended) { ended = true; detach(); controller.error(failure()); void request('read_cancel', { handle: reader }).catch(() => {}); } };
        return new ReadableStream({
          start(value) { controller = value; readOptions.signal?.addEventListener('abort', abort, { once: true }); if (readOptions.signal?.aborted) abort(); },
          async pull(value) {
            if (ended) return;
            try {
              const next = expect(await request('read_next', { handle: reader }, idle), ['done', 'bytes']);
              if (ended) return;
              if (typeof next.done !== 'boolean') throw failure();
              const data = bytes(next.bytes);
              if (data.length > 4 * 1024 * 1024 - received || next.done && data.length) throw failure();
              received += data.length;
              if (next.done) { ended = true; detach(); value.close(); } else value.enqueue(data);
            } catch (error) { if (!ended) { ended = true; detach(); value.error(error); void request('read_cancel', { handle: reader }).catch(() => { terminate(); }); } }
          },
          async cancel() { if (!ended) { ended = true; detach(); await request('read_cancel', { handle: reader }); } },
        }, { highWaterMark: 0 });
      },
    });
    return Object.freeze({ sandboxId, files,
      commands: Object.freeze({ async run(command, commandOptions = {}) {
        requireString(command, 'SDK command', { maxLength: 8_192 });
        assertPlainObject(commandOptions, 'SDK command options');
        assertAllowedKeys(commandOptions, ['timeoutMs'], 'SDK command options');
        const timeoutMs = boundedInteger(commandOptions.timeoutMs, 'command timeout', { min: 1, max: 600_000 });
        return expect(await request('command_run', { handle: owned, command, timeoutMs }, Math.min(deadlineMs, timeoutMs)), ['exitCode', 'stdout', 'stderr']);
      } }),
      async setTimeout(timeoutMs) { boundedInteger(timeoutMs, 'SDK timeout', { min: 1, max: 600_000 }); await request('set_timeout', { handle: owned, timeoutMs }); },
      async kill() { const result = expect(await request('child_kill', { handle: owned }), ['acknowledged']); return result.acknowledged === true; },
    });
  };
  const boundary = Object.freeze({
    metrics() {
      // Local lifecycle counters only: no identifiers, provider billing,
      // sandbox-absence claims, or new receipt/qualification family.
      return Object.freeze({ ...metrics, sdk_process_retired: retired,
        sdk_process_exit_observed: exited, production_qualified: false,
        provider_cleanup_verified: false });
    },
    async inspect() { return start(); },
    async load(expected) {
      const current = await start();
      if (canonicalize(expected) !== canonicalize(current)) throw failure();
      if (loaded) return loaded;
      loaded = (async () => {
        const observed = expect(await request('load', { expected: current }), ['binding']);
        if (canonicalize(observed.binding) !== canonicalize(current)) throw failure();
        class SandboxFacade {
          constructor() { throw new TypeError('SDK process sandbox instances are host-owned'); }
          static async create(template, createOptions) { requireString(template, 'SDK template', { maxLength: 500 }); assertPlainObject(createOptions, 'SDK create options'); return sandboxFacade(await request('create', { template, options: createOptions })); }
          static async getInfo(sandboxId) { requireString(sandboxId, 'sandboxId', { maxLength: 500 }); return request('get_info', { sandboxId }); }
          static async kill(sandboxId) { requireString(sandboxId, 'sandboxId', { maxLength: 500 }); const result = expect(await request('kill', { sandboxId }), ['acknowledged']); return result.acknowledged === true; }
          static list(listOptions) {
            assertPlainObject(listOptions, 'SDK list options');
            const snapshot = JSON.parse(canonicalize(listOptions));
            let hasNext = true;
            let cursor;
            let active = false;
            let closed = false;
            return Object.freeze({ get hasNext() { return hasNext; }, async close() {
              closed = true;
              hasNext = false;
              if (cursor) await request('list_close', { handle: cursor });
            }, async nextItems() {
              if (active || !hasNext) throw failure();
              active = true;
              try {
                if (!cursor) { const opened = expect(await request('list_open', { options: snapshot }), ['handle', 'hasNext']); cursor = handle(opened.handle); if (typeof opened.hasNext !== 'boolean') throw failure(); hasNext = opened.hasNext; }
                if (closed) { hasNext = false; await request('list_close', { handle: cursor }); return []; }
                if (hasNext === false) return [];
                const next = expect(await request('list_next', { handle: cursor }), ['items', 'hasNext']);
                if (!Array.isArray(next.items) || typeof next.hasNext !== 'boolean') throw failure();
                hasNext = !closed && next.hasNext;
                return next.items;
              } finally { active = false; }
            } });
          }
        }
        Object.freeze(SandboxFacade.prototype); Object.freeze(SandboxFacade);
        return Object.freeze({ module: Object.freeze({ Sandbox: SandboxFacade }), ...current });
      })().catch((error) => { terminate(); throw error; });
      return loaded;
    },
    async close() {
      terminate();
      if (exitPromise && !exited) {
        let timer;
        await Promise.race([exitPromise, new Promise((resolve) => { timer = setTimeout(resolve, deadlineMs); })]);
        clearTimeout(timer);
      }
      return Object.freeze({ sdk_process_terminated: !child || exited,
        sdk_process_tree_cleanup_verified: false,
        provider_cleanup_verified: false, provider_outcome: 'unknown' });
    },
  });
  BOUNDARIES.add(boundary);
  return boundary;
}
