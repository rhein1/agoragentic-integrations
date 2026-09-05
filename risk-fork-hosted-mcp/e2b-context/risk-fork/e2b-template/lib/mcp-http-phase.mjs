import {
  resolve4 as nodeResolve4,
  resolve6 as nodeResolve6,
  resolveCname as nodeResolveCname,
} from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { request as nodeHttpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';

import { canonicalize, sha256Ref } from '../../src/canonical.mjs';
import {
  RISK_FORK_MCP_MAX_CNAME_DEPTH,
  RISK_FORK_MCP_MAX_DNS_ANSWERS,
  RISK_FORK_MCP_TRANSPORT_EVIDENCE_SCHEMA,
  canonicalMcpDnsName,
  createMcpTransportResult,
  createMcpWireHeaders,
  createMcpWireParams,
  publicMcpUnicastAddress,
  validateMcpHttpPhaseOperation,
  validateMcpToolHeaderAnnotations,
} from '../../src/mcp-transport-contract.mjs';

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 20_000;
const MAX_JSON_STRING_BYTES = 256 * 1024;
const MAX_RESPONSE_HEADERS_BYTES = 16 * 1024;
const MAX_SSE_EVENTS = 256;
const MAX_SSE_LINE_BYTES = 256 * 1024;
const ABSENT_DNS_CODES = new Set(['ENODATA', 'ENOTFOUND']);
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DEPENDENCY_KEYS = Object.freeze([
  'resolve4',
  'resolve6',
  'resolveCname',
  'httpsRequest',
  'monotonicNow',
]);
const mcpHttpPhaseRuntimes = new WeakSet();

function sha256BytesRef(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object`);
  }
  return value;
}

function assertAllowedKeys(value, allowed, field) {
  assertPlainObject(value, field);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new TypeError(`${field} contains unsupported fields: ${unexpected.sort().join(', ')}`);
  }
}

function exactKeys(value, keys, field) {
  assertAllowedKeys(value, keys, field);
  if (keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${field} is missing required fields`);
  }
}

function boundedJsonParser(bytes, options = {}) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new TypeError('MCP response body must be bytes');
  }
  const maxDepth = options.maxDepth ?? MAX_JSON_DEPTH;
  const maxNodes = options.maxNodes ?? MAX_JSON_NODES;
  const maxStringBytes = options.maxStringBytes ?? MAX_JSON_STRING_BYTES;
  if (bytes.byteLength >= 3
    && bytes[0] === 0xef
    && bytes[1] === 0xbb
    && bytes[2] === 0xbf) {
    throw new TypeError('MCP response JSON must not contain a byte-order mark');
  }
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new TypeError('MCP response body is not valid UTF-8');
  }
  if (source.charCodeAt(0) === 0xfeff) {
    throw new TypeError('MCP response JSON must not contain a byte-order mark');
  }
  let index = 0;
  let nodes = 0;

  function fail(message) {
    throw new TypeError(`MCP response JSON ${message} at byte-independent offset ${index}`);
  }

  function whitespace() {
    while (index < source.length && /[\u0009\u000a\u000d\u0020]/.test(source[index])) {
      index += 1;
    }
  }

  function stringValue() {
    if (source[index] !== '"') fail('requires a string');
    const start = index;
    index += 1;
    let closed = false;
    while (index < source.length) {
      const code = source.charCodeAt(index);
      if (code < 0x20) fail('contains an unescaped control character');
      if (source[index] === '"') {
        index += 1;
        closed = true;
        break;
      }
      if (source[index] === '\\') {
        index += 1;
        if (index >= source.length || !/["\\/bfnrtu]/.test(source[index])) {
          fail('contains an invalid string escape');
        }
        if (source[index] === 'u') {
          const digits = source.slice(index + 1, index + 5);
          if (!/^[a-fA-F0-9]{4}$/.test(digits)) fail('contains an invalid Unicode escape');
          index += 4;
        }
      }
      index += 1;
    }
    if (!closed) fail('contains an unterminated string');
    let value;
    try {
      value = JSON.parse(source.slice(start, index));
    } catch {
      fail('contains an invalid string');
    }
    for (let offset = 0; offset < value.length; offset += 1) {
      const code = value.charCodeAt(offset);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(offset + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail('contains an unpaired surrogate');
        offset += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        fail('contains an unpaired surrogate');
      }
    }
    if (Buffer.byteLength(value, 'utf8') > maxStringBytes) {
      fail('contains a string above its byte bound');
    }
    return value;
  }

  function value(depth) {
    nodes += 1;
    if (nodes > maxNodes) fail('exceeds its node bound');
    if (depth > maxDepth) fail('exceeds its depth bound');
    whitespace();
    if (source[index] === '"') return stringValue();
    if (source[index] === '{') {
      index += 1;
      whitespace();
      const result = Object.create(null);
      const keys = new Set();
      if (source[index] === '}') {
        index += 1;
        return result;
      }
      while (index < source.length) {
        whitespace();
        const key = stringValue();
        if (DANGEROUS_JSON_KEYS.has(key)) fail('contains a forbidden object key');
        if (keys.has(key)) fail(`contains duplicate object key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (source[index] !== ':') fail('requires a colon after an object key');
        index += 1;
        const child = value(depth + 1);
        Object.defineProperty(result, key, {
          configurable: false,
          enumerable: true,
          writable: false,
          value: child,
        });
        whitespace();
        if (source[index] === '}') {
          index += 1;
          return result;
        }
        if (source[index] !== ',') fail('requires a comma between object fields');
        index += 1;
      }
      fail('contains an unterminated object');
    }
    if (source[index] === '[') {
      index += 1;
      whitespace();
      const result = [];
      if (source[index] === ']') {
        index += 1;
        return result;
      }
      while (index < source.length) {
        result.push(value(depth + 1));
        whitespace();
        if (source[index] === ']') {
          index += 1;
          return result;
        }
        if (source[index] !== ',') fail('requires a comma between array items');
        index += 1;
      }
      fail('contains an unterminated array');
    }
    for (const [token, parsed] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ]) {
      if (source.startsWith(token, index)) {
        index += token.length;
        return parsed;
      }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      source.slice(index),
    )?.[0];
    if (!number) fail('contains an invalid value');
    index += number.length;
    const parsed = Number(number);
    if (!Number.isFinite(parsed)
      || Object.is(parsed, -0)
      || (Number.isInteger(parsed) && !Number.isSafeInteger(parsed))) {
      fail('contains a non-canonical number');
    }
    return parsed;
  }

  whitespace();
  if (index >= source.length) fail('is empty');
  const parsed = value(0);
  whitespace();
  if (index !== source.length) fail('contains trailing data');
  return parsed;
}

export function parseBoundedMcpJson(bytes) {
  return boundedJsonParser(bytes);
}

async function optionalDnsQuery(resolver, name, recordType) {
  try {
    const answers = await resolver(name);
    if (!Array.isArray(answers)) {
      throw new TypeError(`MCP ${recordType} resolver returned a non-array result`);
    }
    return answers;
  } catch (error) {
    if (ABSENT_DNS_CODES.has(error?.code)) return [];
    throw new Error(`MCP ${recordType} resolution failed`, { cause: error });
  }
}

function sortAddresses(addresses) {
  return [...addresses].sort((left, right) => {
    const familyDifference = isIP(left) - isIP(right);
    return familyDifference || left.localeCompare(right, 'en');
  });
}

export async function resolvePublicMcpDestination(dnsNameValue, dependencies = {}) {
  assertAllowedKeys(
    dependencies,
    ['resolve4', 'resolve6', 'resolveCname'],
    'MCP DNS dependencies',
  );
  const resolve4 = dependencies.resolve4 ?? nodeResolve4;
  const resolve6 = dependencies.resolve6 ?? nodeResolve6;
  const resolveCname = dependencies.resolveCname ?? nodeResolveCname;
  for (const [resolver, name] of [
    [resolve4, 'resolve4'],
    [resolve6, 'resolve6'],
    [resolveCname, 'resolveCname'],
  ]) {
    if (typeof resolver !== 'function') throw new TypeError(`MCP ${name} dependency is invalid`);
  }
  const dnsName = canonicalMcpDnsName(dnsNameValue);
  const cnameChain = [dnsName];
  const resolvedAddresses = new Set();
  let dnsQueryCount = 0;

  for (let depth = 0; depth < RISK_FORK_MCP_MAX_CNAME_DEPTH; depth += 1) {
    const current = cnameChain.at(-1);
    dnsQueryCount += 3;
    const [ipv4, ipv6, aliases] = await Promise.all([
      optionalDnsQuery(resolve4, current, 'A'),
      optionalDnsQuery(resolve6, current, 'AAAA'),
      optionalDnsQuery(resolveCname, current, 'CNAME'),
    ]);
    for (const [answer, recordType] of [
      ...ipv4.map((entry) => [entry, 'A']),
      ...ipv6.map((entry) => [entry, 'AAAA']),
    ]) {
      publicMcpUnicastAddress(answer, `MCP ${recordType} answer for ${current}`);
      resolvedAddresses.add(answer);
      if (resolvedAddresses.size > RISK_FORK_MCP_MAX_DNS_ANSWERS) {
        throw new Error('MCP DNS resolution exceeded its answer bound');
      }
    }
    if (aliases.length === 0) break;
    if (aliases.length !== 1) throw new Error('MCP DNS resolution returned multiple CNAMEs');
    const alias = canonicalMcpDnsName(
      aliases[0].toLowerCase().replace(/\.$/, ''),
      `MCP CNAME answer for ${current}`,
    );
    if (cnameChain.includes(alias)) throw new Error('MCP DNS resolution contains a CNAME cycle');
    if (cnameChain.length >= RISK_FORK_MCP_MAX_CNAME_DEPTH) {
      throw new Error('MCP DNS resolution exceeded its CNAME depth bound');
    }
    cnameChain.push(alias);
  }
  if (resolvedAddresses.size === 0) {
    throw new Error('MCP DNS resolution produced no public addresses');
  }
  const addresses = sortAddresses(resolvedAddresses);
  return Object.freeze({
    dns_name: dnsName,
    cname_chain: Object.freeze(cnameChain),
    resolved_addresses: Object.freeze(addresses),
    selected_address: addresses[0],
    dns_query_count: dnsQueryCount,
  });
}

function singleHeader(headers, name) {
  const value = headers[name];
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new Error(`MCP response ${name} header is ambiguous`);
    return String(value[0]);
  }
  return String(value);
}

function assertMcpResponseHeaders(response) {
  const contentType = singleHeader(response.headers, 'content-type');
  const normalizedContentType = contentType?.trim() ?? '';
  const responseContentType = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i
    .test(normalizedContentType)
    ? 'application/json'
    : /^text\/event-stream(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(normalizedContentType)
      ? 'text/event-stream'
      : null;
  if (!responseContentType) {
    throw new Error('MCP response must be bounded application/json or text/event-stream');
  }
  if (singleHeader(response.headers, 'content-encoding') !== null) {
    throw new Error('MCP response content encoding is not accepted');
  }
  if (singleHeader(response.headers, 'set-cookie') !== null
    || singleHeader(response.headers, 'mcp-session-id') !== null
    || singleHeader(response.headers, 'www-authenticate') !== null
    || singleHeader(response.headers, 'trailer') !== null) {
    throw new Error('MCP response attempted to create session, cookie, or access state');
  }
  const contentLength = singleHeader(response.headers, 'content-length');
  if (contentLength === null) {
    return Object.freeze({ contentLength: null, responseContentType });
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) {
    throw new Error('MCP response content length is invalid');
  }
  return Object.freeze({ contentLength: Number(contentLength), responseContentType });
}

function extractMcpResult(response, requestId, operation) {
  const envelope = assertPlainObject(response, 'MCP JSON-RPC response');
  const hasResult = Object.hasOwn(envelope, 'result');
  const keys = hasResult ? ['jsonrpc', 'id', 'result'] : ['jsonrpc', 'id', 'error'];
  exactKeys(envelope, keys, 'MCP JSON-RPC response');
  if (envelope.jsonrpc !== '2.0' || envelope.id !== requestId) {
    throw new Error('MCP JSON-RPC response is not bound to the exact request');
  }
  if (!hasResult) throw new Error('MCP JSON-RPC response returned a remote error');
  const wireResult = assertPlainObject(envelope.result, 'MCP JSON-RPC result');
  if (wireResult.resultType !== 'complete') {
    throw new Error(
      wireResult.resultType === 'input_required'
        ? 'MCP input_required result is not accepted by the no-retry protection profile'
        : 'MCP JSON-RPC result requires resultType complete',
    );
  }
  if (operation.phase === 'server/discover') {
    if (!Array.isArray(wireResult.supportedVersions)
      || wireResult.supportedVersions.length < 1
      || wireResult.supportedVersions.length > 32
      || wireResult.supportedVersions.some(
        (version) => typeof version !== 'string' || version.length > 32,
      )
      || !wireResult.supportedVersions.includes(operation.protocol_version)) {
      throw new Error('MCP discovery does not support the required protocol revision');
    }
    assertPlainObject(wireResult.capabilities, 'MCP discovery capabilities');
    return Object.freeze({
      mcpResult: Object.freeze({
        protocol_version: operation.protocol_version,
        stateless: true,
      }),
      wireResult,
    });
  }
  let applicationResult = wireResult;
  if (operation.phase === 'tools/list' && Array.isArray(wireResult.tools)) {
    applicationResult = {
      ...wireResult,
      tools: wireResult.tools.filter((tool) => {
        try {
          const descriptor = assertPlainObject(tool, 'MCP tools/list tool');
          validateMcpToolHeaderAnnotations(descriptor.inputSchema);
          return true;
        } catch {
          return false;
        }
      }),
    };
  }
  const normalized = Object.fromEntries(Object.entries(applicationResult).filter(
    ([key]) => !['resultType', '_meta', 'ttlMs', 'cacheScope'].includes(key),
  ));
  return Object.freeze({
    mcpResult: JSON.parse(canonicalize(normalized)),
    wireResult,
  });
}

function requestBody(operation) {
  return Buffer.from(canonicalize({
    jsonrpc: '2.0',
    id: operation.mcp_request_hash,
    method: operation.phase,
    params: createMcpWireParams(operation),
  }), 'utf8');
}

function parseBoundedMcpSse(bytes, requestId) {
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new TypeError('MCP SSE response is not valid UTF-8');
  }
  if (source.charCodeAt(0) === 0xfeff || source.includes('\u0000')) {
    throw new TypeError('MCP SSE response contains a forbidden marker');
  }
  const messages = [];
  let eventName = '';
  let dataLines = [];

  function dispatchEvent() {
    if (dataLines.length === 0) {
      eventName = '';
      return;
    }
    if (eventName && eventName !== 'message') {
      throw new Error('MCP SSE response contains an unsupported event type');
    }
    if (messages.length >= MAX_SSE_EVENTS) {
      throw new Error('MCP SSE response exceeds its event bound');
    }
    const data = dataLines.join('\n');
    messages.push(parseBoundedMcpJson(Buffer.from(data, 'utf8')));
    eventName = '';
    dataLines = [];
  }

  for (const line of source.split(/\r\n|\r|\n/)) {
    if (Buffer.byteLength(line, 'utf8') > MAX_SSE_LINE_BYTES) {
      throw new Error('MCP SSE response exceeds its line bound');
    }
    if (line === '') {
      dispatchEvent();
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
    else if (field === 'id' || field === 'retry') {
      throw new Error('MCP SSE response attempted resumable or retry state');
    } else {
      throw new Error('MCP SSE response contains an unsupported field');
    }
  }
  dispatchEvent();
  if (messages.length === 0) throw new Error('MCP SSE response contains no messages');

  let finalResponse = null;
  let notificationCount = 0;
  for (const message of messages) {
    const envelope = assertPlainObject(message, 'MCP SSE JSON-RPC message');
    if (Object.hasOwn(envelope, 'id')) {
      if (finalResponse !== null) throw new Error('MCP SSE response contains multiple finals');
      if (envelope.id !== requestId) {
        throw new Error('MCP SSE final response is not bound to the exact request');
      }
      finalResponse = envelope;
      continue;
    }
    if (finalResponse !== null) {
      throw new Error('MCP SSE response continued after its final response');
    }
    throw new Error('MCP SSE response contains an unsolicited notification');
  }
  if (finalResponse === null) throw new Error('MCP SSE response has no final response');
  return Object.freeze({
    parsedResponse: finalResponse,
    eventCount: messages.length,
    notificationCount,
  });
}

async function directMcpJsonRequest(operation, resolution, body, dependencies, timeoutMs) {
  const parsed = new URL(operation.mcp_server_ref);
  const protocolHeaders = createMcpWireHeaders(operation);
  const started = dependencies.monotonicNow();
  let connectionAttempts = 0;
  let lookupCalls = 0;
  let tlsProtocol = null;
  let tlsVerified = false;

  const response = await new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const timer = setTimeout(() => {
      const error = new Error('MCP HTTPS request exceeded its deadline');
      if (request) request.destroy(error);
      if (!settled) {
        settled = true;
        reject(error);
      }
    }, timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }

    const options = {
      protocol: 'https:',
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 443,
      path: parsed.pathname,
      method: 'POST',
      agent: false,
      servername: operation.destination_policy.dns_name,
      family: isIP(resolution.selected_address),
      autoSelectFamily: false,
      rejectUnauthorized: true,
      maxHeaderSize: MAX_RESPONSE_HEADERS_BYTES,
      headers: {
        ...protocolHeaders,
        'Content-Length': String(body.byteLength),
        Host: parsed.host,
        Connection: 'close',
      },
      lookup(hostname, _lookupOptions, callback) {
        lookupCalls += 1;
        if (lookupCalls !== 1 || hostname !== operation.destination_policy.dns_name) {
          callback(new Error('MCP HTTPS lookup escaped its exact DNS binding'));
          return;
        }
        callback(
          null,
          resolution.selected_address,
          isIP(resolution.selected_address),
        );
      },
    };

    try {
      request = dependencies.httpsRequest(options, (incoming) => {
        if (lookupCalls !== 1 || connectionAttempts !== 1 || tlsVerified !== true) {
          incoming.destroy?.();
          finish(new Error('MCP HTTPS connection did not prove one pinned TLS attempt'));
          return;
        }
        if (incoming.statusCode !== 200) {
          incoming.destroy?.();
          finish(new Error(
            incoming.statusCode >= 300 && incoming.statusCode < 400
              ? 'MCP HTTPS redirects are rejected'
              : 'MCP HTTPS response status is not successful',
          ));
          return;
        }
        let declaredLength;
        let responseContentType;
        try {
          ({ contentLength: declaredLength, responseContentType } = assertMcpResponseHeaders(
            incoming,
          ));
          if (declaredLength !== null && declaredLength > operation.max_response_bytes) {
            throw new Error('MCP response declared length exceeds its byte bound');
          }
        } catch (error) {
          incoming.destroy?.();
          finish(error);
          return;
        }
        const chunks = [];
        let responseBytes = 0;
        incoming.on('data', (chunk) => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += bytes.byteLength;
          if (responseBytes > operation.max_response_bytes) {
            incoming.destroy?.();
            finish(new Error('MCP response body exceeds its byte bound'));
            return;
          }
          chunks.push(bytes);
        });
        incoming.once('aborted', () => finish(new Error('MCP response was aborted')));
        incoming.once('error', (error) => finish(error));
        incoming.once('end', () => {
          if (incoming.complete !== true
            || Object.keys(incoming.trailers ?? {}).length !== 0
            || (incoming.rawTrailers?.length ?? 0) !== 0) {
            finish(new Error('MCP response did not end as one complete trailer-free message'));
            return;
          }
          if (declaredLength !== null && declaredLength !== responseBytes) {
            finish(new Error('MCP response content length does not match its body'));
            return;
          }
          if (responseBytes < 1) {
            finish(new Error('MCP response body is empty'));
            return;
          }
          try {
            const responseBody = Buffer.concat(chunks, responseBytes);
            const parsed = responseContentType === 'application/json'
              ? {
                  parsedResponse: parseBoundedMcpJson(responseBody),
                  eventCount: 0,
                  notificationCount: 0,
                }
              : parseBoundedMcpSse(responseBody, operation.mcp_request_hash);
            finish(null, {
              ...parsed,
              responseBody,
              responseBytes,
              responseContentType,
            });
          } catch (error) {
            finish(error);
          }
        });
      });
      request.once('socket', (socket) => {
        connectionAttempts += 1;
        if (connectionAttempts !== 1) {
          const error = new Error('MCP HTTPS attempted more than one connection');
          request.destroy(error);
          finish(error);
          return;
        }
        socket.setNoDelay?.(true);
        socket.once('secureConnect', () => {
          if (socket.authorized !== true
            || socket.authorizationError != null
            || socket.remoteAddress !== resolution.selected_address
            || socket.servername !== operation.destination_policy.dns_name) {
            const error = new Error('MCP HTTPS socket failed its pin or TLS identity check');
            request.destroy(error);
            finish(error);
            return;
          }
          tlsProtocol = socket.getProtocol?.() ?? null;
          if (!['TLSv1.2', 'TLSv1.3'].includes(tlsProtocol)) {
            const error = new Error('MCP HTTPS negotiated an unsupported TLS protocol');
            request.destroy(error);
            finish(error);
            return;
          }
          tlsVerified = true;
        });
      });
      request.once('error', (error) => finish(error));
      request.end(body);
    } catch (error) {
      finish(error);
    }
  });

  const elapsedMs = Math.ceil(dependencies.monotonicNow() - started);
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > timeoutMs) {
    throw new Error('MCP HTTPS request time exceeded its remaining bound');
  }
  const extracted = extractMcpResult(
    response.parsedResponse,
    operation.mcp_request_hash,
    operation,
  );
  return {
    body,
    mcpResult: extracted.mcpResult,
    wireResult: extracted.wireResult,
    responseBody: response.responseBody,
    responseBytes: response.responseBytes,
    responseContentType: response.responseContentType,
    eventCount: response.eventCount,
    notificationCount: response.notificationCount,
    elapsedMs,
    connectionAttempts,
    tlsProtocol,
  };
}

export function createMcpHttpPhaseRuntime(dependencies = {}) {
  assertAllowedKeys(dependencies, DEPENDENCY_KEYS, 'MCP HTTP phase runtime dependencies');
  const runtime = {
    resolve4: dependencies.resolve4 ?? nodeResolve4,
    resolve6: dependencies.resolve6 ?? nodeResolve6,
    resolveCname: dependencies.resolveCname ?? nodeResolveCname,
    httpsRequest: dependencies.httpsRequest ?? nodeHttpsRequest,
    monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
  };
  for (const [name, dependency] of Object.entries(runtime)) {
    if (typeof dependency !== 'function') {
      throw new TypeError(`MCP HTTP phase runtime dependency ${name} is invalid`);
    }
  }

  const runtimeCapability = async function executeMcpHttpPhase(operationValue) {
    const operation = validateMcpHttpPhaseOperation(operationValue);
    const body = requestBody(operation);
    if (body.byteLength > 1024 * 1024) throw new Error('MCP request body exceeds its byte bound');
    const phaseStarted = runtime.monotonicNow();
    const dnsPromise = resolvePublicMcpDestination(
      operation.destination_policy.dns_name,
      {
        resolve4: runtime.resolve4,
        resolve6: runtime.resolve6,
        resolveCname: runtime.resolveCname,
      },
    );
    let dnsTimer;
    const resolution = await Promise.race([
      dnsPromise,
      new Promise((_, reject) => {
        dnsTimer = setTimeout(
          () => reject(new Error('MCP DNS resolution exceeded the operation deadline')),
          operation.timeout_ms,
        );
      }),
    ]).finally(() => clearTimeout(dnsTimer));
    const afterDns = runtime.monotonicNow();
    const dnsElapsedMs = Math.ceil(afterDns - phaseStarted);
    if (!Number.isSafeInteger(dnsElapsedMs)
      || dnsElapsedMs < 0
      || dnsElapsedMs >= operation.timeout_ms) {
      throw new Error('MCP DNS resolution consumed the operation deadline');
    }
    const requested = await directMcpJsonRequest(
      operation,
      resolution,
      body,
      runtime,
      operation.timeout_ms - dnsElapsedMs,
    );
    const elapsedMs = Math.ceil(runtime.monotonicNow() - phaseStarted);
    if (!Number.isSafeInteger(elapsedMs)
      || elapsedMs < 0
      || elapsedMs > operation.timeout_ms) {
      throw new Error('MCP HTTP phase exceeded the operation deadline');
    }
    const evidence = {
      schema: RISK_FORK_MCP_TRANSPORT_EVIDENCE_SCHEMA,
      destination_policy_hash: operation.destination_policy.policy_hash,
      requested_url: operation.mcp_server_ref,
      final_url: operation.mcp_server_ref,
      redirect_count: 0,
      dns_name: operation.destination_policy.dns_name,
      cname_chain: [...resolution.cname_chain],
      resolved_addresses: [...resolution.resolved_addresses],
      selected_address: resolution.selected_address,
      tls_authorized: true,
      tls_server_name: operation.destination_policy.dns_name,
      http_host: new URL(operation.mcp_server_ref).host,
      proxy_used: false,
      request_body_hash: sha256BytesRef(requested.body),
      response_body_hash: sha256BytesRef(requested.responseBody),
      wire_result_hash: sha256Ref(requested.wireResult),
      wire_result_type: 'complete',
      measurements: {
        dns_query_count: resolution.dns_query_count,
        connection_attempt_count: requested.connectionAttempts,
        http_request_count: 1,
        retry_count: 0,
        request_body_bytes: requested.body.byteLength,
        response_body_bytes: requested.responseBytes,
        elapsed_ms: elapsedMs,
        http_status_code: 200,
        tls_protocol: requested.tlsProtocol,
        response_content_type: requested.responseContentType,
        response_content_encoding: null,
        decompression_used: false,
        sse_used: requested.responseContentType === 'text/event-stream',
        sse_event_count: requested.eventCount,
        sse_notification_count: requested.notificationCount,
        protocol_metadata_sent: true,
        method_header_sent: true,
        name_header_sent: ['tools/call', 'resources/read', 'prompts/get']
          .includes(operation.phase),
        parameter_header_count: Object.keys(createMcpWireHeaders(operation))
          .filter((name) => name.toLowerCase().startsWith('mcp-param-')).length,
        access_header_sent: false,
        cookie_header_sent: false,
        state_header_sent: false,
        response_cookie_received: false,
        response_state_created: false,
        access_challenge_received: false,
      },
      evidence_hash: null,
    };
    return createMcpTransportResult(operation, evidence, requested.mcpResult);
  };
  mcpHttpPhaseRuntimes.add(runtimeCapability);
  return runtimeCapability;
}

export const executeMcpHttpPhase = createMcpHttpPhaseRuntime();

export function isMcpHttpPhaseRuntime(value) {
  return typeof value === 'function' && mcpHttpPhaseRuntimes.has(value);
}

export function dispatchMcpHttpPhase(runtime, operation) {
  if (!isMcpHttpPhaseRuntime(runtime)) {
    throw new TypeError('MCP HTTP phase execution requires an opaque runtime capability');
  }
  return runtime(operation);
}
