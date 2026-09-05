#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { RISK_FORK_CLIENT_GATE_MAX_GATEWAY_BYTES } from '../src/client-adoption.mjs';
import { containsSecretShapedText } from '../src/util.mjs';

const TOOL_NAME = 'risk_fork_protect';
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_GATEWAY_BYTES = RISK_FORK_CLIENT_GATE_MAX_GATEWAY_BYTES;
const MAX_PENDING_REQUESTS = 16;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 20_000;
const SHUTDOWN_GRACE_MS = 500;
const SHUTDOWN_FORCE_EXIT_MS = 1500;
const SECRET_JSON_PROPERTY = /^(?:(?:x[_-]?)?api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|id[_-]?token|private[_-]?key|secret[_-]?key|client[_-]?secret|secret|credentials?|authorization|password|passphrase|mnemonic|seed[_-]?phrase)$/i;
const VERIFIED_GATEWAY_BOOTSTRAP = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const entrypoint = process.argv[1];
if (typeof entrypoint !== 'string' || !path.isAbsolute(entrypoint)) process.exit(78);
let source;
try {
  source = fs.readFileSync(3, 'utf8');
} catch {
  process.exit(78);
}
try {
  const gatewayModule = new Module(entrypoint, null);
  gatewayModule.filename = entrypoint;
  gatewayModule.paths = Module._nodeModulePaths(path.dirname(entrypoint));
  process.mainModule = gatewayModule;
  gatewayModule._compile(source, entrypoint);
} catch {
  process.exitCode = 78;
}
`;
const ALLOWED_CLIENT_METHODS = new Set([
  'initialize',
  'notifications/cancelled',
  'notifications/initialized',
  'ping',
  'tools/call',
  'tools/list',
]);
const REQUEST_METHODS = new Set(['initialize', 'ping', 'tools/call', 'tools/list']);

const STATUS = Object.freeze({
  schema: 'agoragentic.risk-fork.client-stdio-gate-status.v1',
  mode: 'source_only_default_off',
  expected_tool_inventory: Object.freeze([TOOL_NAME]),
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

function fail(message, code = 'RISK_FORK_CLIENT_GATE_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === 'status') return { command: 'status' };
  if (argv.length !== 5
    || argv[0] !== 'serve'
    || argv[1] !== '--gateway-entrypoint'
    || argv[3] !== '--gateway-sha256') {
    throw fail('Usage: one-tool-stdio-gate.mjs status | serve --gateway-entrypoint <absolute risk-forkd.js> --gateway-sha256 <sha256:hex>');
  }
  const gatewayEntrypoint = path.normalize(argv[2]);
  const gatewaySha256 = argv[4];
  if (!path.isAbsolute(gatewayEntrypoint)
    || path.basename(gatewayEntrypoint) !== 'risk-forkd.js'
    || gatewayEntrypoint.length > 4096
    || /[\u0000-\u001f\u007f]/.test(gatewayEntrypoint)
    || containsSecretShapedText(gatewayEntrypoint)) {
    throw fail('Gateway entrypoint must be an absolute path ending in risk-forkd.js');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(gatewaySha256)) {
    throw fail('Gateway SHA-256 must use sha256:<64 lowercase hex>');
  }
  return { command: 'serve', gatewayEntrypoint, gatewaySha256 };
}

function verifyGateway(entrypoint, expectedHash) {
  if (realpathSync(entrypoint) !== entrypoint) {
    throw fail('Gateway entrypoint must be an exact canonical path');
  }
  const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
  const nonBlock = Number.isInteger(fsConstants.O_NONBLOCK) ? fsConstants.O_NONBLOCK : 0;
  const descriptor = openSync(entrypoint, fsConstants.O_RDONLY | noFollow | nonBlock);
  let bytes;
  try {
    const details = fstatSync(descriptor);
    if (!details.isFile()
      || !Number.isSafeInteger(details.size)
      || details.size < 1
      || details.size > MAX_GATEWAY_BYTES) {
      throw fail(`Gateway entrypoint must be a regular file of at most ${MAX_GATEWAY_BYTES} bytes`);
    }
    bytes = Buffer.alloc(details.size);
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) {
        throw fail('Gateway entrypoint changed while its exact bytes were being read');
      }
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const after = fstatSync(descriptor);
    if (after.size !== details.size
      || readSync(descriptor, extra, 0, 1, details.size) !== 0) {
      throw fail('Gateway entrypoint changed while its exact bytes were being read');
    }
  } finally {
    closeSync(descriptor);
  }
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actual !== expectedHash) {
    throw fail('Gateway entrypoint hash mismatch', 'RISK_FORK_CLIENT_GATE_HASH_MISMATCH');
  }
  return bytes;
}

function isPlainObject(value) {
  return Boolean(value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype);
}

function isJsonRpcMessage(value) {
  return isPlainObject(value) && value.jsonrpc === '2.0';
}

function encodeBoundedSecretFreeJson(value, boundary) {
  const stack = [{ value, depth: 0 }];
  let nodes = 1;
  function pushNode(nodeValue, depth) {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      throw fail(`${boundary} exceeded the decoded JSON structure limit`);
    }
    stack.push({ value: nodeValue, depth });
  }
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > MAX_JSON_DEPTH) {
      throw fail(`${boundary} exceeded the decoded JSON structure limit`);
    }
    if (typeof current.value === 'string') {
      if (containsSecretShapedText(current.value)) {
        throw fail(`${boundary} contained credential-shaped material`);
      }
      continue;
    }
    if (current.value === null || typeof current.value !== 'object') continue;
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pushNode(current.value[index], current.depth + 1);
      }
      continue;
    }
    for (const key of Object.keys(current.value)) {
      if (SECRET_JSON_PROPERTY.test(key) || containsSecretShapedText(key)) {
        throw fail(`${boundary} contained a credential-shaped property`);
      }
      pushNode(current.value[key], current.depth + 1);
    }
  }
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw fail(`${boundary} could not be encoded safely`);
  }
  if (typeof encoded !== 'string' || containsSecretShapedText(encoded)) {
    throw fail(`${boundary} contained credential-shaped material`);
  }
  return encoded;
}

function response(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function errorResponse(id, code, message, data = undefined) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return JSON.stringify({ jsonrpc: '2.0', id, error });
}

function idKey(id) {
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  return `${typeof id}:${String(id)}`;
}

function createBoundedLineReader(stream, onLine, onFailure, onEnd = () => {}) {
  const buffer = Buffer.allocUnsafe(MAX_LINE_BYTES);
  let length = 0;
  let failed = false;
  stream.on('data', (chunk) => {
    if (failed) return;
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segmentLength = end - offset;
      if (length + segmentLength > MAX_LINE_BYTES) {
        failed = true;
        onFailure(fail('MCP line exceeds the one-megabyte client-gate limit'));
        return;
      }
      chunk.copy(buffer, length, offset, end);
      length += segmentLength;
      if (newline === -1) return;
      let line = buffer.subarray(0, length);
      length = 0;
      offset = newline + 1;
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      if (line.length === 0) continue;
      onLine(line.toString('utf8'));
    }
  });
  function finish() {
    if (failed) return;
    failed = true;
    if (length !== 0) {
      onFailure(fail('MCP stream ended with an incomplete frame'));
      return;
    }
    onEnd();
  }
  stream.on('end', finish);
  stream.on('close', finish);
  stream.on('error', (error) => {
    if (failed) return;
    failed = true;
    onFailure(fail(`MCP stream failed: ${error?.code ?? 'stream_error'}`));
  });
}

function safeWrite(stream, line) {
  try {
    return Boolean(!stream.destroyed && stream.writable && stream.write(`${line}\n`));
  } catch {
    return false;
  }
}

function validateGatewayResponse(message) {
  if (Object.hasOwn(message, 'method')) {
    throw fail('Gateway requests and notifications are outside the client-gate surface');
  }
  const hasResult = Object.hasOwn(message, 'result');
  const hasError = Object.hasOwn(message, 'error');
  if (hasResult === hasError) {
    throw fail('Gateway response must contain exactly one of result or error');
  }
  const allowedKeys = hasResult
    ? new Set(['jsonrpc', 'id', 'result'])
    : new Set(['jsonrpc', 'id', 'error']);
  if (Object.keys(message).some((key) => !allowedKeys.has(key))) {
    throw fail('Gateway response contains fields outside the closed response shape');
  }
  if (hasError && (!isPlainObject(message.error)
    || !Number.isInteger(message.error.code)
    || typeof message.error.message !== 'string'
    || message.error.message.length === 0)) {
    throw fail('Gateway returned an invalid JSON-RPC error object');
  }
}

function validateInitialize(message) {
  if (!isPlainObject(message.result)
    || typeof message.result.protocolVersion !== 'string'
    || !isPlainObject(message.result.capabilities)
    || !isPlainObject(message.result.capabilities.tools)) {
    throw fail('Gateway returned an invalid initialize response');
  }
  const capabilityKeys = Object.keys(message.result.capabilities);
  if (capabilityKeys.some((key) => key !== 'tools')) {
    throw fail('Gateway advertised capabilities outside the one-tool surface');
  }
}

function validateToolsList(message) {
  if (!isPlainObject(message.result)
    || !Array.isArray(message.result.tools)
    || message.result.tools.length !== 1
    || !isPlainObject(message.result.tools[0])
    || message.result.tools[0].name !== TOOL_NAME
    || !isPlainObject(message.result.tools[0].inputSchema)
    || message.result.tools[0].inputSchema.type !== 'object'
    || message.result.nextCursor !== undefined) {
    throw fail(
      `Gateway must advertise exactly one non-paginated tool named ${TOOL_NAME}`,
      'RISK_FORK_GATEWAY_TOOL_SURFACE_INVALID',
    );
  }
}

async function serve(options) {
  const gatewayBytes = verifyGateway(options.gatewayEntrypoint, options.gatewaySha256);
  const child = spawn(process.execPath, [
    '--eval',
    VERIFIED_GATEWAY_BOOTSTRAP,
    options.gatewayEntrypoint,
  ], {
    cwd: path.dirname(options.gatewayEntrypoint),
    env: {
      PATH: path.dirname(process.execPath),
      RISK_FORK_CLIENT_GATE: '1',
    },
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  let closing = false;
  let inputEnded = false;
  let clientOutputBackpressured = false;
  let escalationTimer = null;
  let forceExitTimer = null;
  const gatewayProcessGroup = process.platform !== 'win32' && Number.isSafeInteger(child.pid)
    ? -child.pid
    : null;

  function destroyChildPipes() {
    for (const stream of [child.stdin, child.stdout, child.stderr, child.stdio[3]]) {
      if (stream && !stream.destroyed) stream.destroy();
    }
  }

  function signalGatewayTree(signal) {
    if (gatewayProcessGroup !== null) {
      try {
        process.kill(gatewayProcessGroup, signal);
        return true;
      } catch (error) {
        if (error?.code === 'ESRCH') return false;
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) return false;
    try {
      child.kill(signal);
      return true;
    } catch {
      // The bounded force-exit timer remains the final containment boundary.
      return false;
    }
  }

  function gatewayTreeExists() {
    if (gatewayProcessGroup !== null) {
      try {
        process.kill(gatewayProcessGroup, 0);
        return true;
      } catch (error) {
        return error?.code !== 'ESRCH';
      }
    }
    return child.exitCode === null && child.signalCode === null;
  }

  function close(code, reason) {
    if (closing) return;
    closing = true;
    process.stdin.pause();
    if (!process.stdin.destroyed) process.stdin.destroy();
    for (const { id, timer } of pending.values()) {
      clearTimeout(timer);
      if (!safeWrite(process.stdout, errorResponse(id, -32000, reason))) {
        clientOutputBackpressured = true;
      }
    }
    pending.clear();
    process.exitCode = code;
    destroyChildPipes();
    signalGatewayTree('SIGTERM');
    escalationTimer = setTimeout(() => {
      signalGatewayTree('SIGKILL');
      destroyChildPipes();
    }, SHUTDOWN_GRACE_MS);
    forceExitTimer = setTimeout(() => {
      destroyChildPipes();
      process.exit(code);
    }, SHUTDOWN_FORCE_EXIT_MS);
  }

  child.once('close', () => {
    if (!closing || gatewayTreeExists()) return;
    if (escalationTimer) clearTimeout(escalationTimer);
    if (!clientOutputBackpressured && forceExitTimer) clearTimeout(forceExitTimer);
  });

  child.stdin.on('error', () => close(78, 'Gateway input pipe failed'));
  child.stdio[3].on('error', () => close(78, 'Verified gateway bootstrap pipe failed'));
  process.stdout.on('error', () => close(78, 'Client output pipe failed'));
  child.stdio[3].end(gatewayBytes);

  function writeClient(line) {
    if (safeWrite(process.stdout, line)) return true;
    clientOutputBackpressured = true;
    close(78, 'Client output exceeded the client-gate backpressure limit');
    return false;
  }

  createBoundedLineReader(process.stdin, (line) => {
    if (closing) return;
    if (containsSecretShapedText(line)) {
      close(78, 'Client request contained credential-shaped material');
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      writeClient(errorResponse(null, -32700, 'Parse error'));
      return;
    }
    let encodedMessage;
    try {
      encodedMessage = encodeBoundedSecretFreeJson(message, 'Client request');
    } catch (error) {
      close(78, error.message);
      return;
    }
    if (!isJsonRpcMessage(message) || typeof message.method !== 'string') {
      writeClient(errorResponse(message?.id ?? null, -32600, 'Invalid Request'));
      return;
    }
    if (!ALLOWED_CLIENT_METHODS.has(message.method)) {
      if (message.id !== undefined) {
        writeClient(errorResponse(message.id, -32601, 'Method not found'));
      }
      return;
    }
    const isRequest = REQUEST_METHODS.has(message.method);
    if ((isRequest && message.id === undefined) || (!isRequest && message.id !== undefined)) {
      writeClient(errorResponse(message.id ?? null, -32600, 'Invalid Request'));
      return;
    }
    if (message.method === 'tools/call'
      && (!isPlainObject(message.params) || message.params.name !== TOOL_NAME)) {
      writeClient(errorResponse(
        message.id ?? null,
        -32602,
        `Only ${TOOL_NAME} is available through this client gate`,
      ));
      return;
    }
    if (message.id !== undefined) {
      const key = idKey(message.id);
      if (key === null || pending.has(key)) {
        writeClient(errorResponse(message.id ?? null, -32600, 'Invalid or duplicate request id'));
        return;
      }
      if (pending.size >= MAX_PENDING_REQUESTS) {
        writeClient(errorResponse(
          message.id,
          -32002,
          `At most ${MAX_PENDING_REQUESTS} client-gate requests may be in flight`,
        ));
        return;
      }
      const timer = setTimeout(
        () => close(78, `Gateway request exceeded the ${REQUEST_TIMEOUT_MS}-millisecond deadline`),
        REQUEST_TIMEOUT_MS,
      );
      pending.set(key, { id: message.id, method: message.method, timer });
    }
    if (!safeWrite(child.stdin, encodedMessage)) {
      close(78, 'Gateway input exceeded the client-gate backpressure limit');
    }
  }, (error) => close(78, error.message));

  createBoundedLineReader(child.stdout, (line) => {
    if (closing) return;
    if (containsSecretShapedText(line)) {
      close(78, 'Gateway response contained credential-shaped material');
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      close(78, 'Gateway emitted invalid JSON');
      return;
    }
    let encodedMessage;
    try {
      encodedMessage = encodeBoundedSecretFreeJson(message, 'Gateway response');
    } catch (error) {
      close(78, error.message);
      return;
    }
    if (!isJsonRpcMessage(message) || message.id === undefined) {
      close(78, 'Gateway emitted a message outside the closed response surface');
      return;
    }
    const key = idKey(message.id);
    const request = key === null ? null : pending.get(key);
    if (!request) {
      close(78, 'Gateway returned an unknown request id');
      return;
    }
    try {
      validateGatewayResponse(message);
      clearTimeout(request.timer);
      pending.delete(key);
      if (message.error === undefined) {
        if (request.method === 'initialize') validateInitialize(message);
        if (request.method === 'tools/list') validateToolsList(message);
      }
    } catch (error) {
      clearTimeout(request.timer);
      pending.delete(key);
      writeClient(errorResponse(
        message.id,
        -32001,
        error.message,
        { reason_code: error.code ?? 'RISK_FORK_CLIENT_GATE_INVALID' },
      ));
      close(78, 'Gateway tool surface failed closed');
      return;
    }
    writeClient(encodedMessage);
  }, (error) => close(78, error.message), () => {
    if (!closing && !(inputEnded && pending.size === 0)) {
      close(78, 'Gateway response stream ended before the gateway process exited');
    }
  });

  child.stderr.on('data', () => {});
  child.stderr.on('error', () => close(78, 'Gateway diagnostic pipe failed'));
  child.on('error', () => close(78, 'Gateway process could not start'));
  child.on('exit', (code) => {
    if (closing) return;
    if (inputEnded && pending.size === 0 && code === 0) {
      closing = true;
      process.stdin.pause();
      process.exitCode = 0;
      return;
    }
    close(code === 0 ? 78 : (code ?? 78), 'Gateway process exited');
  });
  process.stdin.on('end', () => {
    if (closing || inputEnded) return;
    inputEnded = true;
    process.stdin.pause();
    if (!child.stdin.destroyed) child.stdin.end();
    const timeout = setTimeout(() => close(78, 'Gateway did not stop after client input closed'), 2000);
    timeout.unref();
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => close(0, `Client gate received ${signal}`));
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'status') {
    process.stdout.write(`${JSON.stringify(STATUS)}\n`);
  } else {
    await serve(options);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ...STATUS,
    startup: 'refused',
    reason_code: error?.code ?? 'RISK_FORK_CLIENT_GATE_INVALID',
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 78;
}
