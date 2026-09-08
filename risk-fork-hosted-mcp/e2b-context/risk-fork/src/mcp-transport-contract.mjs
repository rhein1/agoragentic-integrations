import { BlockList, isIP } from 'node:net';

import { canonicalize, sha256Ref } from './canonical.mjs';
import { validateChildOperation } from './child-operation.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  boundedInteger,
  deepFreeze,
  requireExternalEndpoint,
  requireOpaqueRef,
  requireSha256Ref,
  safeEqual,
} from './util.mjs';

export const RISK_FORK_MCP_CHILD_OPERATION_SCHEMA =
  'agoragentic.risk-fork.mcp-child-operation.v1';
export const RISK_FORK_MCP_DESTINATION_POLICY_SCHEMA =
  'agoragentic.risk-fork.mcp-destination-policy.v1';
export const RISK_FORK_MCP_TRANSPORT_RESULT_SCHEMA =
  'agoragentic.risk-fork.mcp-transport-result.v1';
export const RISK_FORK_MCP_TRANSPORT_EVIDENCE_SCHEMA =
  'agoragentic.risk-fork.mcp-transport-evidence.v1';
export const RISK_FORK_MCP_PROTOCOL_VERSION = '2026-07-28';
export const RISK_FORK_MCP_CLIENT_INFO = Object.freeze({
  name: '@agoragentic/risk-fork',
  version: '0.1.0-alpha.1',
});
export const RISK_FORK_MCP_PHASES = Object.freeze([
  'server/discover',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
]);
export const RISK_FORK_MCP_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const RISK_FORK_MCP_MAX_TIMEOUT_MS = 10 * 60 * 1000;
export const RISK_FORK_MCP_MAX_DNS_ANSWERS = 64;
export const RISK_FORK_MCP_MAX_CNAME_DEPTH = 16;

const BLOCKED_DNS_SUFFIXES = Object.freeze([
  'localhost',
  'local',
  'internal',
  'home.arpa',
  'invalid',
  'test',
  'example',
  'onion',
]);
const BLOCKED_IPV4_DESTINATIONS = new BlockList();
const BLOCKED_IPV6_DESTINATIONS = new BlockList();
const GLOBAL_IPV6_DESTINATIONS = new BlockList();
GLOBAL_IPV6_DESTINATIONS.addSubnet('2000::', 3, 'ipv6');
for (const [network, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.31.196.0', 24, 'ipv4'],
  ['192.52.193.0', 24, 'ipv4'],
  ['192.88.99.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['192.175.48.0', 24, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['::ffff:0:0', 96, 'ipv6'],
  ['64:ff9b::', 96, 'ipv6'],
  ['64:ff9b:1::', 48, 'ipv6'],
  ['100::', 64, 'ipv6'],
  ['2001::', 23, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['2002::', 16, 'ipv6'],
  ['3fff::', 20, 'ipv6'],
  ['5f00::', 16, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
]) {
  (family === 'ipv4' ? BLOCKED_IPV4_DESTINATIONS : BLOCKED_IPV6_DESTINATIONS)
    .addSubnet(network, prefix, family);
}

const DESTINATION_POLICY_KEYS = Object.freeze([
  'schema',
  'requested_url',
  'requested_origin',
  'dns_name',
  'dns_resolution',
  'accepted_dns_record_types',
  'address_scope',
  'pin_selected_address',
  'preserve_tls_server_name',
  'preserve_http_host',
  'proxy_environment_allowed',
  'redirects',
  'max_redirects',
  'transport_evidence_required',
  'policy_hash',
]);
const OPERATION_KEYS = Object.freeze([
  'schema',
  'kind',
  'mcp_request_hash',
  'phase',
  'mcp_server_ref',
  'mcp_server_origin',
  'tool_name',
  'tool_descriptor_hash',
  'tool_input_schema',
  'tool_input_schema_hash',
  'tool_effect_status',
  'tool_safety_binding_hash',
  'params',
  'protocol_version',
  'destination_policy',
  'redirects',
  'response_mode',
  'mcp_result_schema',
  'mcp_result_schema_hash',
  'response_schema',
  'response_schema_hash',
  'max_response_bytes',
  'timeout_ms',
  'operation_hash',
]);
const TRANSPORT_EVIDENCE_KEYS = Object.freeze([
  'schema',
  'destination_policy_hash',
  'requested_url',
  'final_url',
  'redirect_count',
  'dns_name',
  'cname_chain',
  'resolved_addresses',
  'selected_address',
  'tls_authorized',
  'tls_server_name',
  'http_host',
  'proxy_used',
  'request_body_hash',
  'response_body_hash',
  'wire_result_hash',
  'wire_result_type',
  'measurements',
  'evidence_hash',
]);
const TRANSPORT_MEASUREMENT_KEYS = Object.freeze([
  'dns_query_count',
  'connection_attempt_count',
  'http_request_count',
  'retry_count',
  'request_body_bytes',
  'response_body_bytes',
  'elapsed_ms',
  'http_status_code',
  'tls_protocol',
  'response_content_type',
  'response_content_encoding',
  'decompression_used',
  'sse_used',
  'sse_event_count',
  'sse_notification_count',
  'protocol_metadata_sent',
  'method_header_sent',
  'name_header_sent',
  'parameter_header_count',
  'access_header_sent',
  'cookie_header_sent',
  'state_header_sent',
  'response_cookie_received',
  'response_state_created',
  'access_challenge_received',
]);

function exactKeys(value, keys, field) {
  assertAllowedKeys(value, keys, field);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) throw new TypeError(`${field} is missing required fields`);
}

function exactJson(left, right) {
  return safeEqual(sha256Ref(left), sha256Ref(right));
}

function encodeMcpHeaderValue(value) {
  const text = String(value);
  const sentinel = text.startsWith('=?base64?') && text.endsWith('?=');
  const plainAscii = /^[\x20-\x7e]*$/.test(text);
  if (plainAscii && text.trim() === text && !sentinel) return text;
  return `=?base64?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function collectMcpParameterHeaderSpecs(inputSchema) {
  const root = assertPlainObject(inputSchema, 'MCP tool inputSchema');
  const found = [];
  const names = new Set();

  function visitUnknown(value, pathIsReachable, propertyPath) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) visitUnknown(child, false, propertyPath);
      return;
    }
    const node = assertPlainObject(value, 'MCP tool schema node');
    if (Object.hasOwn(node, 'x-mcp-header')) {
      if (!pathIsReachable || propertyPath.length === 0) {
        throw new TypeError('MCP x-mcp-header must be statically reachable through properties');
      }
      const annotation = node['x-mcp-header'];
      if (typeof annotation !== 'string'
        || annotation.length < 1
        || annotation.length > 128
        || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(annotation)) {
        throw new TypeError('MCP x-mcp-header name is invalid');
      }
      if (!['string', 'integer', 'boolean'].includes(node.type)) {
        throw new TypeError('MCP x-mcp-header must annotate a string, integer, or boolean');
      }
      const normalizedName = annotation.toLowerCase();
      if (names.has(normalizedName)) {
        throw new TypeError('MCP x-mcp-header names must be case-insensitively unique');
      }
      names.add(normalizedName);
      found.push(Object.freeze({
        header: `Mcp-Param-${annotation}`,
        path: Object.freeze([...propertyPath]),
        type: node.type,
      }));
      if (found.length > 64) throw new TypeError('MCP x-mcp-header count exceeds its bound');
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'x-mcp-header') continue;
      if (key === 'properties') {
        const properties = assertPlainObject(child, 'MCP tool inputSchema properties');
        for (const [propertyName, propertySchema] of Object.entries(properties)) {
          visitUnknown(propertySchema, pathIsReachable, [...propertyPath, propertyName]);
        }
      } else {
        visitUnknown(child, false, propertyPath);
      }
    }
  }

  visitUnknown(root, true, []);
  return Object.freeze(found);
}

export function validateMcpToolHeaderAnnotations(inputSchema) {
  collectMcpParameterHeaderSpecs(inputSchema);
  return true;
}

function valueAtOwnPath(value, path) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) {
      return Object.freeze({ present: false, value: undefined });
    }
    current = current[key];
  }
  return Object.freeze({ present: true, value: current });
}

export function createMcpWireHeaders(operationValue) {
  const operation = validateMcpHttpPhaseOperation(operationValue);
  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': operation.protocol_version,
    'Mcp-Method': operation.phase,
  };
  let principalName = null;
  if (['tools/call', 'prompts/get'].includes(operation.phase)) {
    principalName = operation.params.name;
  } else if (operation.phase === 'resources/read') {
    principalName = operation.params.uri;
  }
  if (principalName !== null) {
    requireOpaqueRef(principalName, `MCP ${operation.phase} principal name`, { maxLength: 4096 });
    headers['Mcp-Name'] = encodeMcpHeaderValue(principalName);
  }
  if (operation.phase === 'tools/call') {
    const argumentsValue = operation.params.arguments ?? {};
    assertPlainObject(argumentsValue, 'MCP tools/call arguments');
    const inputSchema = assertPlainObject(
      operation.tool_input_schema,
      'MCP tools/call descriptor inputSchema',
    );
    for (const spec of collectMcpParameterHeaderSpecs(inputSchema)) {
      const extracted = valueAtOwnPath(argumentsValue, spec.path);
      if (!extracted.present || extracted.value === null) continue;
      if ((spec.type === 'integer'
          && (!Number.isSafeInteger(extracted.value)))
        || (spec.type !== 'integer' && typeof extracted.value !== spec.type)) {
        throw new TypeError(`MCP ${spec.header} value does not match its annotated type`);
      }
      headers[spec.header] = encodeMcpHeaderValue(extracted.value);
    }
  }
  return deepFreeze(JSON.parse(canonicalize(headers)));
}

export function createMcpWireParams(operationValue) {
  const operation = validateMcpHttpPhaseOperation(operationValue);
  const params = operation.phase === 'server/discover'
    ? {}
    : JSON.parse(canonicalize(operation.params));
  params._meta = {
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': RISK_FORK_MCP_CLIENT_INFO,
    'io.modelcontextprotocol/protocolVersion': operation.protocol_version,
  };
  return deepFreeze(JSON.parse(canonicalize(params)));
}

export function canonicalMcpDnsName(value, field = 'MCP DNS name') {
  if (typeof value !== 'string' || value !== value.toLowerCase() || value.endsWith('.')) {
    throw new TypeError(`${field} must be a canonical lowercase DNS name`);
  }
  if (isIP(value) !== 0
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
    || BLOCKED_DNS_SUFFIXES.some((suffix) => value === suffix || value.endsWith(`.${suffix}`))) {
    throw new TypeError(`${field} must be a public DNS name`);
  }
  return value;
}

export function publicMcpUnicastAddress(value, field = 'MCP destination address') {
  if (typeof value !== 'string') throw new TypeError(`${field} must be an IP address`);
  const familyNumber = isIP(value);
  if (familyNumber === 0) throw new TypeError(`${field} must be an IP address`);
  const family = familyNumber === 4 ? 'ipv4' : 'ipv6';
  const blockList = familyNumber === 4
    ? BLOCKED_IPV4_DESTINATIONS
    : BLOCKED_IPV6_DESTINATIONS;
  if ((familyNumber === 6 && !GLOBAL_IPV6_DESTINATIONS.check(value, family))
    || blockList.check(value, family)) {
    throw new TypeError(`${field} must be a public unicast address`);
  }
  return value;
}

export function publicMcpEndpoint(value, field = 'MCP endpoint') {
  const href = requireExternalEndpoint(value, field);
  const parsed = new URL(href);
  if (parsed.protocol !== 'https:') throw new TypeError(`${field} must use HTTPS`);
  canonicalMcpDnsName(parsed.hostname.toLowerCase(), `${field} hostname`);
  return href;
}

export function createMcpDestinationPolicy(target) {
  assertAllowedKeys(target, ['href', 'origin'], 'MCP destination');
  const href = publicMcpEndpoint(target.href, 'MCP destination URL');
  const parsed = new URL(href);
  if (href !== target.href || target.origin !== parsed.origin) {
    throw new TypeError('MCP destination URL and origin must be exact and canonical');
  }
  const policy = {
    schema: RISK_FORK_MCP_DESTINATION_POLICY_SCHEMA,
    requested_url: href,
    requested_origin: parsed.origin,
    dns_name: canonicalMcpDnsName(parsed.hostname.toLowerCase(), 'MCP destination DNS name'),
    dns_resolution: 'child_before_each_connection_attempt',
    accepted_dns_record_types: ['A', 'AAAA', 'CNAME'],
    address_scope: 'public_unicast_only',
    pin_selected_address: true,
    preserve_tls_server_name: true,
    preserve_http_host: true,
    proxy_environment_allowed: false,
    redirects: 'error',
    max_redirects: 0,
    transport_evidence_required: true,
    policy_hash: null,
  };
  policy.policy_hash = sha256Ref(policy);
  return deepFreeze(policy);
}

export function validateMcpDestinationPolicy(value) {
  const policy = assertPlainObject(value, 'MCP destination policy');
  exactKeys(policy, DESTINATION_POLICY_KEYS, 'MCP destination policy');
  const expected = createMcpDestinationPolicy({
    href: policy.requested_url,
    origin: policy.requested_origin,
  });
  if (!exactJson(policy, expected)) {
    throw new TypeError('MCP destination policy is not canonical and fail closed');
  }
  return expected;
}

function measurementSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...TRANSPORT_MEASUREMENT_KEYS],
    properties: {
      dns_query_count: { type: 'integer', minimum: 3, maximum: 48 },
      connection_attempt_count: { const: 1 },
      http_request_count: { const: 1 },
      retry_count: { const: 0 },
      request_body_bytes: { type: 'integer', minimum: 1, maximum: 1048576 },
      response_body_bytes: {
        type: 'integer',
        minimum: 1,
        maximum: RISK_FORK_MCP_MAX_RESPONSE_BYTES,
      },
      elapsed_ms: { type: 'integer', minimum: 0, maximum: RISK_FORK_MCP_MAX_TIMEOUT_MS },
      http_status_code: { const: 200 },
      tls_protocol: { enum: ['TLSv1.2', 'TLSv1.3'] },
      response_content_type: { enum: ['application/json', 'text/event-stream'] },
      response_content_encoding: { type: 'null' },
      decompression_used: { const: false },
      sse_used: { type: 'boolean' },
      sse_event_count: { type: 'integer', minimum: 0, maximum: 256 },
      sse_notification_count: { type: 'integer', minimum: 0, maximum: 255 },
      protocol_metadata_sent: { const: true },
      method_header_sent: { const: true },
      name_header_sent: { type: 'boolean' },
      parameter_header_count: { type: 'integer', minimum: 0, maximum: 64 },
      access_header_sent: { const: false },
      cookie_header_sent: { const: false },
      state_header_sent: { const: false },
      response_cookie_received: { const: false },
      response_state_created: { const: false },
      access_challenge_received: { const: false },
    },
  };
}

export function createMcpTransportResultSchema(mcpResultSchema) {
  assertPlainObject(mcpResultSchema, 'MCP result schema');
  return deepFreeze({
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'transport_evidence', 'mcp_result'],
    properties: {
      schema: { const: RISK_FORK_MCP_TRANSPORT_RESULT_SCHEMA },
      transport_evidence: {
        type: 'object',
        additionalProperties: false,
        required: [...TRANSPORT_EVIDENCE_KEYS],
        properties: {
          schema: { const: RISK_FORK_MCP_TRANSPORT_EVIDENCE_SCHEMA },
          destination_policy_hash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
          requested_url: { type: 'string', maxLength: 4096 },
          final_url: { type: 'string', maxLength: 4096 },
          redirect_count: { type: 'integer', minimum: 0, maximum: 0 },
          dns_name: { type: 'string', maxLength: 253 },
          cname_chain: {
            type: 'array',
            minItems: 1,
            maxItems: RISK_FORK_MCP_MAX_CNAME_DEPTH,
            items: { type: 'string', maxLength: 253 },
          },
          resolved_addresses: {
            type: 'array',
            minItems: 1,
            maxItems: RISK_FORK_MCP_MAX_DNS_ANSWERS,
            items: { type: 'string', maxLength: 64 },
          },
          selected_address: { type: 'string', maxLength: 64 },
          tls_authorized: { const: true },
          tls_server_name: { type: 'string', maxLength: 253 },
          http_host: { type: 'string', maxLength: 512 },
          proxy_used: { const: false },
          request_body_hash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
          response_body_hash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
          wire_result_hash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
          wire_result_type: { const: 'complete' },
          measurements: measurementSchema(),
          evidence_hash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        },
      },
      mcp_result: mcpResultSchema,
    },
  });
}

function validateMeasurements(value, operation, cnameCount) {
  const measurements = assertPlainObject(value, 'Risk Fork MCP transport measurements');
  exactKeys(
    measurements,
    TRANSPORT_MEASUREMENT_KEYS,
    'Risk Fork MCP transport measurements',
  );
  for (const [field, expected] of Object.entries({
    dns_query_count: cnameCount * 3,
    connection_attempt_count: 1,
    http_request_count: 1,
    retry_count: 0,
    http_status_code: 200,
  })) {
    if (measurements[field] !== expected) {
      throw new TypeError(`Risk Fork MCP transport measurement ${field} is invalid`);
    }
  }
  boundedInteger(measurements.request_body_bytes, 'MCP request body bytes', {
    min: 1,
    max: 1024 * 1024,
  });
  boundedInteger(measurements.response_body_bytes, 'MCP response body bytes', {
    min: 1,
    max: operation.max_response_bytes,
  });
  boundedInteger(measurements.elapsed_ms, 'MCP elapsed milliseconds', {
    min: 0,
    max: operation.timeout_ms,
  });
  const expectedNameHeader = ['tools/call', 'resources/read', 'prompts/get']
    .includes(operation.phase);
  const expectedParameterHeaderCount = Object.keys(createMcpWireHeaders(operation))
    .filter((name) => name.toLowerCase().startsWith('mcp-param-')).length;
  if (!['TLSv1.2', 'TLSv1.3'].includes(measurements.tls_protocol)
    || !['application/json', 'text/event-stream'].includes(
      measurements.response_content_type,
    )
    || measurements.response_content_encoding !== null
    || measurements.decompression_used !== false
    || measurements.sse_used !== (measurements.response_content_type === 'text/event-stream')
    || !Number.isSafeInteger(measurements.sse_event_count)
    || measurements.sse_event_count < 0
    || measurements.sse_event_count > 256
    || !Number.isSafeInteger(measurements.sse_notification_count)
    || measurements.sse_notification_count < 0
    || measurements.sse_notification_count >= Math.max(1, measurements.sse_event_count)
    || (measurements.sse_used === false
      && (measurements.sse_event_count !== 0 || measurements.sse_notification_count !== 0))
    || measurements.protocol_metadata_sent !== true
    || measurements.method_header_sent !== true
    || measurements.name_header_sent !== expectedNameHeader
    || measurements.parameter_header_count !== expectedParameterHeaderCount
    || measurements.access_header_sent !== false
    || measurements.cookie_header_sent !== false
    || measurements.state_header_sent !== false
    || measurements.response_cookie_received !== false
    || measurements.response_state_created !== false
    || measurements.access_challenge_received !== false) {
    throw new TypeError('Risk Fork MCP transport measurements violate the closed transport');
  }
  return measurements;
}

export function verifyMcpTransportResult(value, operationValue) {
  const operation = validateMcpHttpPhaseOperation(operationValue);
  exactKeys(
    value,
    ['schema', 'transport_evidence', 'mcp_result'],
    'Risk Fork MCP transport result',
  );
  if (value.schema !== RISK_FORK_MCP_TRANSPORT_RESULT_SCHEMA) {
    throw new TypeError('Risk Fork MCP transport result schema is invalid');
  }
  const evidence = assertPlainObject(
    value.transport_evidence,
    'Risk Fork MCP transport evidence',
  );
  exactKeys(
    evidence,
    TRANSPORT_EVIDENCE_KEYS,
    'Risk Fork MCP transport evidence',
  );
  const destination = operation.destination_policy;
  const parsed = new URL(destination.requested_url);
  if (evidence.schema !== RISK_FORK_MCP_TRANSPORT_EVIDENCE_SCHEMA
    || !safeEqual(evidence.destination_policy_hash, destination.policy_hash)
    || evidence.requested_url !== destination.requested_url
    || evidence.final_url !== destination.requested_url
    || evidence.redirect_count !== 0
    || evidence.dns_name !== destination.dns_name
    || evidence.tls_authorized !== true
    || evidence.tls_server_name !== destination.dns_name
    || evidence.http_host !== parsed.host
    || evidence.proxy_used !== false
    || evidence.wire_result_type !== 'complete') {
    throw new TypeError('Risk Fork MCP transport evidence does not match its destination policy');
  }
  requireSha256Ref(evidence.request_body_hash, 'Risk Fork MCP request body hash');
  requireSha256Ref(evidence.response_body_hash, 'Risk Fork MCP response body hash');
  requireSha256Ref(evidence.wire_result_hash, 'Risk Fork MCP wire result hash');
  if (!Array.isArray(evidence.cname_chain)
    || evidence.cname_chain.length < 1
    || evidence.cname_chain.length > RISK_FORK_MCP_MAX_CNAME_DEPTH
    || evidence.cname_chain[0] !== destination.dns_name) {
    throw new TypeError('Risk Fork MCP transport CNAME evidence is invalid');
  }
  const cnameNames = evidence.cname_chain.map((entry, index) => (
    canonicalMcpDnsName(entry, `Risk Fork MCP transport CNAME[${index}]`)
  ));
  if (new Set(cnameNames).size !== cnameNames.length) {
    throw new TypeError('Risk Fork MCP transport CNAME evidence contains a cycle');
  }
  if (!Array.isArray(evidence.resolved_addresses)
    || evidence.resolved_addresses.length < 1
    || evidence.resolved_addresses.length > RISK_FORK_MCP_MAX_DNS_ANSWERS) {
    throw new TypeError('Risk Fork MCP transport address evidence is invalid');
  }
  const addresses = evidence.resolved_addresses.map((entry, index) => (
    publicMcpUnicastAddress(entry, `Risk Fork MCP transport address[${index}]`)
  ));
  if (new Set(addresses).size !== addresses.length
    || !addresses.includes(publicMcpUnicastAddress(
      evidence.selected_address,
      'Risk Fork MCP selected transport address',
    ))) {
    throw new TypeError('Risk Fork MCP selected address is not pinned to the resolved set');
  }
  validateMeasurements(evidence.measurements, operation, cnameNames.length);
  requireSha256Ref(evidence.evidence_hash, 'Risk Fork MCP transport evidence hash');
  if (!safeEqual(
    evidence.evidence_hash,
    sha256Ref({ ...evidence, evidence_hash: null }),
  )) {
    throw new TypeError('Risk Fork MCP transport evidence hash mismatch');
  }
  return value.mcp_result;
}

export function validateMcpHttpPhaseOperation(value) {
  const operation = validateChildOperation(value, 'MCP HTTP phase operation');
  exactKeys(operation, OPERATION_KEYS, 'MCP HTTP phase operation');
  if (operation.schema !== RISK_FORK_MCP_CHILD_OPERATION_SCHEMA
    || operation.kind !== 'mcp_http_phase'
    || !RISK_FORK_MCP_PHASES.includes(operation.phase)
    || operation.protocol_version !== RISK_FORK_MCP_PROTOCOL_VERSION
    || operation.redirects !== 'error'
    || operation.response_mode !== 'json_or_sse') {
    throw new TypeError('MCP HTTP phase operation contract is invalid');
  }
  requireSha256Ref(operation.mcp_request_hash, 'MCP HTTP phase request hash');
  const href = publicMcpEndpoint(operation.mcp_server_ref, 'MCP HTTP phase server ref');
  const parsed = new URL(href);
  if (href !== operation.mcp_server_ref || operation.mcp_server_origin !== parsed.origin) {
    throw new TypeError('MCP HTTP phase endpoint binding is invalid');
  }
  assertPlainObject(operation.params, 'MCP HTTP phase params');
  if (['_meta', 'inputResponses', 'requestState'].some(
    (key) => Object.hasOwn(operation.params, key),
  )) {
    throw new TypeError('MCP HTTP phase params contain host-owned protocol fields');
  }
  if (operation.phase === 'server/discover') {
    exactKeys(
      operation.params,
      ['protocol_version', 'stateless_required'],
      'MCP server/discover host intent',
    );
    if (operation.params.protocol_version !== RISK_FORK_MCP_PROTOCOL_VERSION
      || operation.params.stateless_required !== true) {
      throw new TypeError('MCP server/discover host intent is not the required stateless revision');
    }
  }
  if (['prompts/get', 'tools/call'].includes(operation.phase)) {
    requireOpaqueRef(operation.params.name, `MCP ${operation.phase} params.name`, {
      maxLength: 4096,
    });
  }
  if (operation.phase === 'resources/read') {
    requireOpaqueRef(operation.params.uri, 'MCP resources/read params.uri', { maxLength: 4096 });
  }
  const destination = validateMcpDestinationPolicy(operation.destination_policy);
  const expectedDestination = createMcpDestinationPolicy({
    href: operation.mcp_server_ref,
    origin: operation.mcp_server_origin,
  });
  if (!exactJson(destination, expectedDestination)) {
    throw new TypeError('MCP HTTP phase destination policy binding is invalid');
  }
  if (operation.phase === 'tools/call') {
    requireOpaqueRef(operation.tool_name, 'MCP HTTP phase tool name', { maxLength: 500 });
    requireSha256Ref(operation.tool_descriptor_hash, 'MCP HTTP phase tool descriptor hash');
    assertPlainObject(operation.tool_input_schema, 'MCP HTTP phase tool input schema');
    requireSha256Ref(operation.tool_input_schema_hash, 'MCP HTTP phase tool input schema hash');
    requireSha256Ref(operation.tool_safety_binding_hash, 'MCP HTTP phase tool safety binding hash');
    if (!safeEqual(operation.tool_input_schema_hash, sha256Ref(operation.tool_input_schema))
      || operation.tool_effect_status !== 'explicit_read_only'
      || operation.params.name !== operation.tool_name) {
      throw new TypeError('MCP HTTP phase tools/call is not exact-bound read-only work');
    }
  } else if ([
    operation.tool_name,
    operation.tool_descriptor_hash,
    operation.tool_input_schema,
    operation.tool_input_schema_hash,
    operation.tool_effect_status,
    operation.tool_safety_binding_hash,
  ].some((entry) => entry !== null)) {
    throw new TypeError('Non-call MCP HTTP phases contain tool effect metadata');
  }
  assertPlainObject(operation.mcp_result_schema, 'MCP HTTP phase result schema');
  assertPlainObject(operation.response_schema, 'MCP HTTP phase response schema');
  requireSha256Ref(operation.mcp_result_schema_hash, 'MCP HTTP phase result schema hash');
  requireSha256Ref(operation.response_schema_hash, 'MCP HTTP phase response schema hash');
  requireSha256Ref(operation.operation_hash, 'MCP HTTP phase operation hash');
  if (!safeEqual(operation.mcp_result_schema_hash, sha256Ref(operation.mcp_result_schema))
    || !exactJson(
      operation.response_schema,
      createMcpTransportResultSchema(operation.mcp_result_schema),
    )
    || !safeEqual(operation.response_schema_hash, sha256Ref(operation.response_schema))
    || !safeEqual(
      operation.operation_hash,
      sha256Ref({ ...operation, operation_hash: null }),
    )) {
    throw new TypeError('MCP HTTP phase schema or operation hash binding is invalid');
  }
  boundedInteger(operation.max_response_bytes, 'MCP HTTP phase max_response_bytes', {
    min: 1024,
    max: RISK_FORK_MCP_MAX_RESPONSE_BYTES,
  });
  boundedInteger(operation.timeout_ms, 'MCP HTTP phase timeout_ms', {
    min: 100,
    max: RISK_FORK_MCP_MAX_TIMEOUT_MS,
  });
  return deepFreeze(JSON.parse(canonicalize(operation)));
}

export function createMcpTransportResult(operationValue, evidenceValue, mcpResult) {
  const operation = validateMcpHttpPhaseOperation(operationValue);
  const evidence = {
    ...evidenceValue,
    evidence_hash: null,
  };
  evidence.evidence_hash = sha256Ref(evidence);
  const result = deepFreeze(JSON.parse(canonicalize({
    schema: RISK_FORK_MCP_TRANSPORT_RESULT_SCHEMA,
    transport_evidence: evidence,
    mcp_result: mcpResult,
  })));
  verifyMcpTransportResult(result, operation);
  return result;
}
