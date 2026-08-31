import { SCENARIO_IDS, listScenarios } from './scenarios.mjs';
import {
  RISK_FORK_DEMO_BANNER,
  assertDemoSecretFree,
  createDemoTruth,
  redactDemoValue,
} from './security.mjs';

export const MCP_MAX_MESSAGE_BYTES = 64 * 1024;
export const MCP_MAX_PENDING_INPUT_BYTES = 64 * 1024;
export const MCP_MAX_PENDING_MESSAGES = 8;
export const MCP_MAX_REQUEST_ID_BYTES = 256;
export const MCP_SUPPORTED_PROTOCOL_VERSION = '2025-06-18';

const MAX_MESSAGE_BYTES = MCP_MAX_MESSAGE_BYTES;

const TOOLS = Object.freeze([
  {
    name: 'risk_fork_demo_list_scenarios',
    description: 'List the fixed synthetic Risk Fork demo scenarios. Accepts no paths, commands, URLs, repositories, credentials, or remote targets.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'risk_fork_demo_plan',
    description: 'Classify one fixed synthetic scenario in the host without allocating or writing anything.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['scenario'],
      properties: { scenario: { type: 'string', enum: SCENARIO_IDS } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'risk_fork_demo_run',
    description: 'Run one fixed synthetic scenario in the owned local demo root. The host determines whether a disposable local protocol copy is required.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['scenario'],
      properties: { scenario: { type: 'string', enum: SCENARIO_IDS } },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'risk_fork_demo_receipt',
    description: 'Read a previously created sanitized demo receipt by opaque run id.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id'],
      properties: { run_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,100}$' } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
]);

function response(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function failure(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function invalidRequest() {
  return Object.assign(new Error('Invalid JSON-RPC request'), { rpcCode: -32600 });
}

function validatedRequestId(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw invalidRequest();
  if (!Object.hasOwn(message, 'id') || message.id === null) return null;
  if (typeof message.id === 'number' && Number.isSafeInteger(message.id)) return message.id;
  if (
    typeof message.id === 'string'
    && Buffer.byteLength(message.id, 'utf8') <= MCP_MAX_REQUEST_ID_BYTES
    && !/[\u0000-\u001f\u007f]/.test(message.id)
  ) {
    assertDemoSecretFree({ json_rpc_id: message.id }, 'MCP request id');
    return message.id;
  }
  throw invalidRequest();
}

function assertExactArguments(value, allowedKeys) {
  if (value === undefined) value = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Tool arguments must be an object');
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !allowedKeys.includes(key)) || keys.length !== allowedKeys.length) {
    throw new TypeError('Tool arguments do not match the closed schema');
  }
  assertDemoSecretFree(value, 'MCP tool arguments');
  return value;
}

function toolResult(value, { isError = false } = {}) {
  const sanitized = redactDemoValue(value);
  assertDemoSecretFree(sanitized, 'MCP tool result');
  return {
    content: [{ type: 'text', text: JSON.stringify(sanitized) }],
    structuredContent: sanitized,
    ...(isError ? { isError: true } : {}),
  };
}

async function callTool(engine, params, onResult) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('tools/call params must be an object');
  }
  const { name, arguments: args } = params;
  if (name === 'risk_fork_demo_list_scenarios') {
    assertExactArguments(args, []);
    return toolResult({
      schema: 'agoragentic.risk-fork.demo-scenario-list.v1',
      banner: RISK_FORK_DEMO_BANNER,
      ...createDemoTruth(),
      scenarios: listScenarios(),
    });
  }
  if (name === 'risk_fork_demo_plan') {
    const input = assertExactArguments(args, ['scenario']);
    if (!SCENARIO_IDS.includes(input.scenario)) throw new TypeError('Unknown synthetic scenario');
    return toolResult(await engine.plan(input.scenario));
  }
  if (name === 'risk_fork_demo_run') {
    const input = assertExactArguments(args, ['scenario']);
    if (!SCENARIO_IDS.includes(input.scenario)) throw new TypeError('Unknown synthetic scenario');
    const result = await engine.run(input.scenario);
    if (typeof onResult === 'function') await onResult(result);
    return toolResult(result, { isError: Number(result.exit_code ?? 0) !== 0 });
  }
  if (name === 'risk_fork_demo_receipt') {
    const input = assertExactArguments(args, ['run_id']);
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.run_id)) throw new TypeError('Invalid run id');
    const result = await engine.getReceipt(input.run_id);
    return toolResult(result, { isError: result?.found !== true });
  }
  throw Object.assign(new Error('Unknown Risk Fork demo tool'), { rpcCode: -32601 });
}

async function dispatch(engine, message, onResult) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw invalidRequest();
  }
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    throw invalidRequest();
  }
  if (message.method === 'notifications/initialized') return null;
  if (!Object.hasOwn(message, 'id')) return null;
  if (message.method === 'initialize') {
    return response(message.id, {
      protocolVersion: MCP_SUPPORTED_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'agoragentic-risk-fork-demo', version: '0.0.0-hackathon.1' },
      instructions: `${RISK_FORK_DEMO_BANNER} The host classifies before effects. Call only the fixed synthetic scenario tools. Never provide credentials, repositories, paths, URLs, wallets, accounts, or production data. This local adapter is not a VM or kernel isolation boundary.`,
    });
  }
  if (message.method === 'ping') return response(message.id, {});
  if (message.method === 'tools/list') return response(message.id, { tools: TOOLS });
  if (message.method === 'tools/call') {
    return response(message.id, await callTool(engine, message.params, onResult));
  }
  throw Object.assign(new Error('Method not found'), { rpcCode: -32601 });
}

export function createMcpMessageHandler({ engine, onResult } = {}) {
  if (!engine || typeof engine.plan !== 'function' || typeof engine.run !== 'function') {
    throw new TypeError('A Risk Fork demo engine is required');
  }
  return async function handle(line) {
    if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) {
      return failure(null, -32600, 'Invalid request');
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return failure(null, -32700, 'Parse error');
    }
    let requestId = null;
    try {
      requestId = validatedRequestId(message);
    } catch (error) {
      return failure(null, Number(error?.rpcCode ?? -32600), 'Risk Fork demo request rejected');
    }
    try {
      assertDemoSecretFree(message, 'MCP request envelope');
    } catch {
      return failure(requestId, -32600, 'Risk Fork demo request rejected');
    }
    try {
      return await dispatch(engine, message, onResult);
    } catch (error) {
      return failure(requestId, Number(error?.rpcCode ?? -32602), 'Risk Fork demo request rejected');
    }
  };
}

export async function serveStdioMcp({ engine, input = process.stdin, output = process.stdout, onResult } = {}) {
  const handle = createMcpMessageHandler({ engine, onResult });
  if (!input || typeof input.on !== 'function') throw new TypeError('MCP input must be a readable stream');
  if (!output || typeof output.write !== 'function') throw new TypeError('MCP output must be a writable stream');

  await new Promise((resolve, reject) => {
    const lineBuffer = Buffer.allocUnsafe(MCP_MAX_MESSAGE_BYTES);
    const pending = [];
    let lineBytes = 0;
    let pendingBytes = 0;
    let activeTask = null;
    let inputEnded = false;
    let protocolClosed = false;
    let settled = false;

    function cleanupListeners() {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onInputError);
      input.off('close', onClose);
    }

    function settleResolve() {
      if (settled) return;
      settled = true;
      cleanupListeners();
      resolve();
    }

    function settleReject(error) {
      if (settled) return;
      settled = true;
      cleanupListeners();
      reject(error);
    }

    function writeValue(value) {
      if (value === null) return Promise.resolve();
      const serialized = `${JSON.stringify(value)}\n`;
      if (output.write(serialized) !== false) return Promise.resolve();
      if (typeof output.once !== 'function' || typeof output.off !== 'function') {
        return Promise.reject(new Error('MCP output cannot signal bounded backpressure'));
      }
      return new Promise((resolveWrite, rejectWrite) => {
        const cleanup = () => {
          output.off('drain', onDrain);
          output.off('error', onError);
        };
        const onDrain = () => {
          cleanup();
          resolveWrite();
        };
        const onError = (error) => {
          cleanup();
          rejectWrite(error);
        };
        output.once('drain', onDrain);
        output.once('error', onError);
      });
    }

    function maybeFinish() {
      if (inputEnded && activeTask === null && pending.length === 0 && lineBytes === 0) {
        settleResolve();
      }
    }

    function startMessage(messageBytes) {
      const task = (async () => {
        const value = await handle(messageBytes.toString('utf8'));
        if (!protocolClosed) await writeValue(value);
      })();
      activeTask = task;
      void task.then(() => {
        if (activeTask !== task) return;
        activeTask = null;
        if (protocolClosed) return;
        const next = pending.shift();
        if (next) {
          pendingBytes -= next.byte_length;
          startMessage(next.message);
          return;
        }
        maybeFinish();
      }, settleReject);
    }

    function closeTerminal({ rejection = null } = {}) {
      if (protocolClosed || settled) return;
      protocolClosed = true;
      const taskAtClose = activeTask;
      activeTask = null;
      pending.length = 0;
      pendingBytes = 0;
      lineBytes = 0;
      cleanupListeners();
      if (typeof input.pause === 'function') input.pause();
      if (typeof input.destroy === 'function') input.destroy();

      const abortTask = typeof engine?.abort === 'function'
        ? Promise.resolve().then(() => engine.abort())
        : Promise.resolve();
      if (taskAtClose) void Promise.resolve(taskAtClose).catch(() => {});
      void abortTask.catch(() => {});
      if (rejection) {
        settleReject(rejection);
        return;
      }
      void writeValue(failure(null, -32600, 'Invalid request'))
        .then(settleResolve, settleReject);
    }

    function closeForProtocolLimit() {
      closeTerminal();
    }

    function closeForInputFailure() {
      closeTerminal({
        rejection: Object.assign(new Error('MCP input stream failed'), {
          code: 'MCP_INPUT_STREAM_FAILED',
        }),
      });
    }

    function closeForUnexpectedClose() {
      closeTerminal({
        rejection: Object.assign(new Error('MCP input stream closed unexpectedly'), {
          code: 'MCP_INPUT_STREAM_CLOSED',
        }),
      });
    }

    function queueMessage(message, byteLength) {
      if (activeTask === null) {
        startMessage(message);
        return true;
      }
      if (
        pending.length >= MCP_MAX_PENDING_MESSAGES
        || pendingBytes + lineBytes + byteLength > MCP_MAX_PENDING_INPUT_BYTES
      ) {
        closeForProtocolLimit();
        return false;
      }
      pending.push({ message, byte_length: byteLength });
      pendingBytes += byteLength;
      return true;
    }

    function finishLine() {
      let messageBytes = lineBytes;
      if (messageBytes > 0 && lineBuffer[messageBytes - 1] === 0x0d) messageBytes -= 1;
      const message = Buffer.from(lineBuffer.subarray(0, messageBytes));
      const bufferedBytes = lineBytes;
      lineBytes = 0;
      return queueMessage(message, bufferedBytes);
    }

    function append(bytes, start, end) {
      const incomingBytes = end - start;
      if (lineBytes + incomingBytes > MCP_MAX_MESSAGE_BYTES) {
        closeForProtocolLimit();
        return false;
      }
      if (
        activeTask !== null
        && pendingBytes + lineBytes + incomingBytes > MCP_MAX_PENDING_INPUT_BYTES
      ) {
        closeForProtocolLimit();
        return false;
      }
      bytes.copy(lineBuffer, lineBytes, start, end);
      lineBytes += incomingBytes;
      return true;
    }

    function asBuffer(chunk) {
      if (Buffer.isBuffer(chunk)) return chunk;
      if (chunk instanceof Uint8Array) {
        return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      }
      if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
      throw new TypeError('MCP input emitted a non-byte chunk');
    }

    function onData(chunk) {
      if (protocolClosed || settled) return;
      let bytes;
      try {
        bytes = asBuffer(chunk);
      } catch {
        closeForProtocolLimit();
        return;
      }
      let offset = 0;
      while (offset < bytes.length && !protocolClosed) {
        const newline = bytes.indexOf(0x0a, offset);
        const end = newline === -1 ? bytes.length : newline;
        if (!append(bytes, offset, end)) return;
        offset = end;
        if (newline === -1) return;
        offset += 1;
        if (!finishLine()) return;
      }
    }

    function onEnd() {
      if (protocolClosed || settled) return;
      inputEnded = true;
      if (lineBytes > 0 && !finishLine()) return;
      maybeFinish();
    }

    function onInputError() {
      if (protocolClosed || settled) return;
      closeForInputFailure();
    }

    function onClose() {
      if (protocolClosed || settled || inputEnded) return;
      closeForUnexpectedClose();
    }

    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onInputError);
    input.once('close', onClose);
  });
}

export const RISK_FORK_DEMO_MCP_TOOLS = TOOLS;
