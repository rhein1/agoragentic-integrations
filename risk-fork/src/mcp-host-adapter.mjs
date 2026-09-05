import { randomUUID } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

import { canonicalize, sha256Ref } from './canonical.mjs';
import { networkPolicy } from './contracts.mjs';
import { assertPreparedForCleanCommit } from './controller.mjs';
import { isRiskForkHostBoundary } from './host-boundary.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  boundedInteger,
  containsSecretShapedText,
  deepFreeze,
  requireExternalEndpoint,
  requireIsoDate,
  requireOpaqueRef,
  requireSha256Ref,
  safeEqual,
} from './util.mjs';

export const RISK_FORK_MCP_HOST_ADAPTER_SCHEMA =
  'agoragentic.risk-fork.mcp-host-adapter.v1';
export const RISK_FORK_MCP_PHASE_PLAN_REQUEST_SCHEMA =
  'agoragentic.risk-fork.mcp-phase-plan-request.v1';
export const RISK_FORK_MCP_PHASE_PLAN_SCHEMA =
  'agoragentic.risk-fork.mcp-phase-plan.v1';
export const RISK_FORK_MCP_CHILD_OPERATION_SCHEMA =
  'agoragentic.risk-fork.mcp-child-operation.v1';
export const RISK_FORK_MCP_DESTINATION_POLICY_SCHEMA =
  'agoragentic.risk-fork.mcp-destination-policy.v1';
export const RISK_FORK_MCP_TRANSPORT_RESULT_SCHEMA =
  'agoragentic.risk-fork.mcp-transport-result.v1';

const MCP_SCHEMAS = Object.freeze({
  sessionOpenRequest: 'agoragentic.mcp.enforced-session-open-request.v1',
  phaseRequest: 'agoragentic.mcp.enforced-phase-request.v1',
  hostSession: 'agoragentic.mcp.enforced-host-session.v1',
  cleanImportedResult: 'agoragentic.mcp.clean-imported-result.v1',
});

const MCP_PROTOCOL_VERSION = '2026-07-28';
const OPEN_PHASE = 'server/discover';
const REQUEST_PHASES = Object.freeze([
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
]);
const ALL_PHASES = Object.freeze([OPEN_PHASE, ...REQUEST_PHASES]);
const TOOL_CAPABILITY_KEYS = Object.freeze([
  'network_access',
  'filesystem_read',
  'filesystem_write',
  'credential_access',
  'wallet_or_payment',
  'deployment',
  'publication',
  'communication',
  'database_mutation',
  'trust_or_reputation_mutation',
  'external_side_effect',
  'unknown_or_unclassified',
]);
const IRREVERSIBLE_TOOL_CAPABILITIES = Object.freeze([
  'network_access',
  'filesystem_write',
  'credential_access',
  'wallet_or_payment',
  'deployment',
  'publication',
  'communication',
  'database_mutation',
  'trust_or_reputation_mutation',
  'external_side_effect',
]);
const TOOL_ANNOTATION_KEYS = Object.freeze([
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
]);
const REQUEST_KEYS = Object.freeze([
  'schema',
  'request_id',
  'phase',
  'raw_method',
  'mcp_server_ref',
  'mcp_server_origin',
  'session_binding_hash',
  'tool_name',
  'tool_descriptor',
  'tool_descriptor_hash',
  'tool_annotations',
  'tool_capabilities',
  'tool_effect_status',
  'params',
  'risk_profile',
  'transport_constraints',
  'fallback_http',
  'request_hash',
]);
const OPERATION_INPUT_KEYS = Object.freeze([
  'capsule',
  'savepoint_input',
  'operation',
  'effective_arguments',
  'expected_commit_type',
  'commit_policy',
  'expected_binding',
  'network_policy',
]);
const DEFAULT_TIMEOUTS = Object.freeze({
  open_session_ms: 15_000,
  request_ms: 30_000,
  close_ms: 5_000,
  fallback_ms: 30_000,
});
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_TIMEOUT_MS = 10;
const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_CHILD_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_DNS_ANSWERS = 64;
const MAX_CNAME_DEPTH = 16;
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

export const RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES = Object.freeze({
  INVALID_CONFIGURATION: 'RISK_FORK_MCP_INVALID_CONFIGURATION',
  INVALID_REQUEST: 'RISK_FORK_MCP_INVALID_REQUEST',
  REQUEST_HASH_MISMATCH: 'RISK_FORK_MCP_REQUEST_HASH_MISMATCH',
  REQUEST_TOO_LARGE: 'RISK_FORK_MCP_REQUEST_TOO_LARGE',
  SESSION_LIMIT: 'RISK_FORK_MCP_SESSION_LIMIT',
  SESSION_CLOSED: 'RISK_FORK_MCP_SESSION_CLOSED',
  SESSION_BINDING_MISMATCH: 'RISK_FORK_MCP_SESSION_BINDING_MISMATCH',
  REQUEST_REPLAY: 'RISK_FORK_MCP_REQUEST_REPLAY',
  REQUEST_CONCURRENT: 'RISK_FORK_MCP_REQUEST_CONCURRENT',
  REQUEST_LIMIT: 'RISK_FORK_MCP_REQUEST_LIMIT',
  PLAN_SOURCE_UNTRUSTED: 'RISK_FORK_MCP_PLAN_SOURCE_UNTRUSTED',
  PLAN_RESOLUTION_FAILED: 'RISK_FORK_MCP_PLAN_RESOLUTION_FAILED',
  PLAN_INVALID: 'RISK_FORK_MCP_PLAN_INVALID',
  PLAN_BINDING_MISMATCH: 'RISK_FORK_MCP_PLAN_BINDING_MISMATCH',
  ACTION_PROPOSAL_REQUIRED: 'RISK_FORK_MCP_ACTION_PROPOSAL_REQUIRED',
  PRE_EFFECT_REJECTED: 'RISK_FORK_MCP_PRE_EFFECT_REJECTED',
  PREPARED_RESULT_INVALID: 'RISK_FORK_MCP_PREPARED_RESULT_INVALID',
  FALLBACK_BLOCKED: 'RISK_FORK_MCP_FALLBACK_BLOCKED',
  DEADLINE_EXCEEDED: 'RISK_FORK_MCP_DEADLINE_EXCEEDED',
  ABORTED: 'RISK_FORK_MCP_ABORTED',
});

export class RiskForkMcpHostAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RiskForkMcpHostAdapterError';
    this.code = code;
  }
}

const adapterRecords = new WeakMap();
const planSourceResolvers = new WeakMap();

function adapterError(code, message) {
  return new RiskForkMcpHostAdapterError(code, message);
}

function exactKeys(value, keys, field) {
  assertAllowedKeys(value, keys, field);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) throw new TypeError(`${field} is missing required fields`);
}

function boundedCanonicalClone(value, field, maxBytes = MAX_PLAN_BYTES) {
  let serialized;
  try {
    serialized = canonicalize(value);
  } catch {
    throw new TypeError(`${field} must be canonical JSON`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw adapterError(
      RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.REQUEST_TOO_LARGE,
      `${field} exceeds the configured byte limit`,
    );
  }
  return deepFreeze(JSON.parse(serialized));
}

function scanSecretValues(value, field) {
  function walk(current) {
    if (typeof current === 'string') {
      if (containsSecretShapedText(current)) {
        throw new TypeError(`${field} contains secret-shaped material`);
      }
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      if (containsSecretShapedText(key)) {
        throw new TypeError(`${field} contains a secret-shaped field`);
      }
      walk(child);
    }
  }
  walk(value);
}

function canonicalDnsName(value, field) {
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

function publicUnicastAddress(value, field) {
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

function publicMcpEndpoint(value, field) {
  const href = requireExternalEndpoint(value, field);
  const parsed = new URL(href);
  if (parsed.protocol !== 'https:') {
    throw new TypeError(`${field} must use HTTPS`);
  }
  canonicalDnsName(parsed.hostname.toLowerCase(), `${field} hostname`);
  return href;
}

function createDestinationPolicy(target) {
  const href = publicMcpEndpoint(target.href, 'MCP destination URL');
  const parsed = new URL(href);
  if (href !== target.href || target.origin !== parsed.origin) {
    throw new TypeError('MCP destination URL and origin must be exact and canonical');
  }
  const policy = {
    schema: RISK_FORK_MCP_DESTINATION_POLICY_SCHEMA,
    requested_url: href,
    requested_origin: parsed.origin,
    dns_name: canonicalDnsName(parsed.hostname.toLowerCase(), 'MCP destination DNS name'),
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

function transportResultSchema(mcpResultSchema) {
  return deepFreeze({
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'transport_evidence', 'mcp_result'],
    properties: {
      schema: { const: RISK_FORK_MCP_TRANSPORT_RESULT_SCHEMA },
      transport_evidence: {
        type: 'object',
        additionalProperties: false,
        required: [
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
          'evidence_hash',
        ],
        properties: {
          schema: { const: 'agoragentic.risk-fork.mcp-transport-evidence.v1' },
          destination_policy_hash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
          requested_url: { type: 'string', maxLength: 4096 },
          final_url: { type: 'string', maxLength: 4096 },
          redirect_count: { type: 'integer', minimum: 0, maximum: 0 },
          dns_name: { type: 'string', maxLength: 253 },
          cname_chain: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_CNAME_DEPTH,
            items: { type: 'string', maxLength: 253 },
          },
          resolved_addresses: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_DNS_ANSWERS,
            items: { type: 'string', maxLength: 64 },
          },
          selected_address: { type: 'string', maxLength: 64 },
          tls_authorized: { const: true },
          tls_server_name: { type: 'string', maxLength: 253 },
          http_host: { type: 'string', maxLength: 512 },
          proxy_used: { const: false },
          evidence_hash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        },
      },
      mcp_result: mcpResultSchema,
    },
  });
}

function verifyTransportResult(value, operation) {
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
  exactKeys(evidence, [
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
    'evidence_hash',
  ], 'Risk Fork MCP transport evidence');
  const destination = operation.destination_policy;
  const parsed = new URL(destination.requested_url);
  if (evidence.schema !== 'agoragentic.risk-fork.mcp-transport-evidence.v1'
    || !safeEqual(evidence.destination_policy_hash, destination.policy_hash)
    || evidence.requested_url !== destination.requested_url
    || evidence.final_url !== destination.requested_url
    || evidence.redirect_count !== 0
    || evidence.dns_name !== destination.dns_name
    || evidence.tls_authorized !== true
    || evidence.tls_server_name !== destination.dns_name
    || evidence.http_host !== parsed.host
    || evidence.proxy_used !== false) {
    throw new TypeError('Risk Fork MCP transport evidence does not match its destination policy');
  }
  if (!Array.isArray(evidence.cname_chain)
    || evidence.cname_chain.length < 1
    || evidence.cname_chain.length > MAX_CNAME_DEPTH
    || evidence.cname_chain[0] !== destination.dns_name) {
    throw new TypeError('Risk Fork MCP transport CNAME evidence is invalid');
  }
  const cnameNames = evidence.cname_chain.map((entry, index) => (
    canonicalDnsName(entry, `Risk Fork MCP transport CNAME[${index}]`)
  ));
  if (new Set(cnameNames).size !== cnameNames.length) {
    throw new TypeError('Risk Fork MCP transport CNAME evidence contains a cycle');
  }
  if (!Array.isArray(evidence.resolved_addresses)
    || evidence.resolved_addresses.length < 1
    || evidence.resolved_addresses.length > MAX_DNS_ANSWERS) {
    throw new TypeError('Risk Fork MCP transport address evidence is invalid');
  }
  const addresses = evidence.resolved_addresses.map((entry, index) => (
    publicUnicastAddress(entry, `Risk Fork MCP transport address[${index}]`)
  ));
  if (new Set(addresses).size !== addresses.length
    || !addresses.includes(publicUnicastAddress(
      evidence.selected_address,
      'Risk Fork MCP selected transport address',
    ))) {
    throw new TypeError('Risk Fork MCP selected address is not pinned to the resolved set');
  }
  requireSha256Ref(evidence.evidence_hash, 'Risk Fork MCP transport evidence hash');
  if (!safeEqual(
    evidence.evidence_hash,
    sha256Ref({ ...evidence, evidence_hash: null }),
  )) {
    throw new TypeError('Risk Fork MCP transport evidence hash mismatch');
  }
  return value.mcp_result;
}

function normalizeTarget(refValue, originValue) {
  const href = publicMcpEndpoint(refValue, 'MCP request.mcp_server_ref');
  const origin = publicMcpEndpoint(originValue, 'MCP request.mcp_server_origin');
  const parsed = new URL(href);
  const expectedOrigin = parsed.origin;
  if (originValue !== expectedOrigin || new URL(origin).origin !== expectedOrigin) {
    throw adapterError(
      RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.INVALID_REQUEST,
      'MCP request server origin does not match the server reference',
    );
  }
  return Object.freeze({ href, origin: expectedOrigin });
}

function assertTransportConstraints(value) {
  exactKeys(value, [
    'direct_network_permitted',
    'https_required',
    'address_scope',
    'dns_resolution',
    'address_pinning_required',
    'proxy_environment_allowed',
    'redirects',
    'max_redirects',
    'transport_evidence_required',
    'response_acceptance',
    'fallback_on_protocol_error',
    'credential_material_in_child',
  ], 'MCP request.transport_constraints');
  if (value.direct_network_permitted !== false
    || value.https_required !== true
    || value.address_scope !== 'public_unicast_only'
    || value.dns_resolution !== 'child_before_each_connection_attempt'
    || value.address_pinning_required !== true
    || value.proxy_environment_allowed !== false
    || value.redirects !== 'error'
    || value.max_redirects !== 0
    || value.transport_evidence_required !== true
    || value.response_acceptance !== 'clean_import_only'
    || value.fallback_on_protocol_error !== false
    || value.credential_material_in_child !== false) {
    throw adapterError(
      RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.INVALID_REQUEST,
      'MCP request transport constraints are not fail closed',
    );
  }
}

function assertRiskProfile(value) {
  exactKeys(
    value,
    ['minimum_level', 'untrusted_content', 'prepare_only'],
    'MCP request.risk_profile',
  );
  if (!['HIGH', 'IRREVERSIBLE'].includes(value.minimum_level)
    || value.untrusted_content !== true
    || value.prepare_only !== (value.minimum_level === 'IRREVERSIBLE')) {
    throw adapterError(
      RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.INVALID_REQUEST,
      'MCP request risk profile is below the mandatory host threshold',
    );
  }
}

function normalizeEnforcementRequest(value, {
  expectedSchema,
  allowedPhases,
  maxBytes,
} = {}) {
  try {
    const request = boundedCanonicalClone(value, 'MCP enforcement request', maxBytes);
    exactKeys(request, REQUEST_KEYS, 'MCP enforcement request');
    if (request.schema !== expectedSchema || !allowedPhases.includes(request.phase)) {
      throw new TypeError('MCP enforcement request schema or phase is invalid');
    }
    requireOpaqueRef(request.request_id, 'MCP enforcement request.request_id');
    requireSha256Ref(request.request_hash, 'MCP enforcement request.request_hash');
    const expectedHash = sha256Ref({ ...request, request_hash: null });
    if (!safeEqual(request.request_hash, expectedHash)) {
      throw adapterError(
        RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.REQUEST_HASH_MISMATCH,
        'MCP enforcement request hash mismatch',
      );
    }
    if (request.raw_method !== null || request.fallback_http !== null) {
      throw new TypeError('Only known MCP phases without fallback metadata are accepted');
    }
    const target = normalizeTarget(request.mcp_server_ref, request.mcp_server_origin);
    assertPlainObject(request.params, 'MCP enforcement request.params');
    assertPlainObject(request.risk_profile, 'MCP enforcement request.risk_profile');
    assertPlainObject(request.transport_constraints, 'MCP enforcement request.transport_constraints');
    assertRiskProfile(request.risk_profile);
    assertTransportConstraints(request.transport_constraints);
    scanSecretValues(request, 'MCP enforcement request');

    if (request.phase === OPEN_PHASE) {
      if (request.session_binding_hash !== null) {
        throw new TypeError('Session-open request must not contain a session binding');
      }
    } else {
      requireSha256Ref(request.session_binding_hash, 'MCP enforcement request.session_binding_hash');
    }
    if (request.phase === 'tools/call') {
      if (!request.tool_descriptor || request.tool_name == null) {
        throw new TypeError('tools/call requires a bound tool descriptor');
      }
      assertPlainObject(request.tool_descriptor, 'MCP enforcement request.tool_descriptor');
      requireOpaqueRef(request.tool_name, 'MCP enforcement request.tool_name', { maxLength: 500 });
      if (request.tool_descriptor.name !== request.tool_name) {
        throw new TypeError('tools/call tool name does not match its bound descriptor');
      }
      requireSha256Ref(request.tool_descriptor_hash, 'MCP enforcement request.tool_descriptor_hash');
      if (!safeEqual(request.tool_descriptor_hash, sha256Ref(request.tool_descriptor))) {
        throw new TypeError('tools/call tool descriptor hash mismatch');
      }
      assertPlainObject(request.tool_capabilities, 'MCP enforcement request.tool_capabilities');
      exactKeys(
        request.tool_capabilities,
        TOOL_CAPABILITY_KEYS,
        'MCP enforcement request.tool_capabilities',
      );
      if (TOOL_CAPABILITY_KEYS.some(
        (key) => typeof request.tool_capabilities[key] !== 'boolean'
          && request.tool_capabilities[key] !== null,
      )) {
        throw new TypeError('tools/call capabilities must be a complete boolean-or-null record');
      }
      const capabilitiesContainNull = TOOL_CAPABILITY_KEYS.some(
        (key) => request.tool_capabilities[key] === null,
      );
      if (capabilitiesContainNull
        && request.tool_capabilities.unknown_or_unclassified !== true) {
        throw new TypeError('Incomplete tools/call capabilities must remain unknown');
      }
      let annotationsComplete = false;
      if (request.tool_annotations !== null) {
        assertPlainObject(request.tool_annotations, 'MCP enforcement request.tool_annotations');
        assertAllowedKeys(
          request.tool_annotations,
          TOOL_ANNOTATION_KEYS,
          'MCP enforcement request.tool_annotations',
        );
        if (Object.values(request.tool_annotations).some(
          (item) => typeof item !== 'boolean',
        )) {
          throw new TypeError('tools/call annotations must be a boolean record');
        }
        annotationsComplete = TOOL_ANNOTATION_KEYS.every(
          (key) => Object.hasOwn(request.tool_annotations, key),
        );
      }
      if (!['explicit_read_only', 'unknown_effectfulness', 'irreversible']
        .includes(request.tool_effect_status)) {
        throw new TypeError('tools/call tool effect status is invalid');
      }
      const hasIrreversibleCapability = IRREVERSIBLE_TOOL_CAPABILITIES.some(
        (key) => request.tool_capabilities[key] === true,
      );
      const unknownEffect = !annotationsComplete
        || request.tool_capabilities.unknown_or_unclassified === true;
      const computedEffectStatus = request.tool_annotations?.destructiveHint === true
        || hasIrreversibleCapability
        ? 'irreversible'
        : unknownEffect || request.tool_annotations.readOnlyHint !== true
          ? 'unknown_effectfulness'
          : 'explicit_read_only';
      if (request.tool_effect_status !== computedEffectStatus) {
        throw new TypeError('tools/call effect status does not match bound metadata');
      }
      if (computedEffectStatus !== 'explicit_read_only'
        && (request.risk_profile.minimum_level !== 'IRREVERSIBLE'
          || request.risk_profile.prepare_only !== true)) {
        throw new TypeError('tools/call risk profile does not match bound effect metadata');
      }
    } else if ([
      request.tool_name,
      request.tool_descriptor,
      request.tool_descriptor_hash,
      request.tool_annotations,
      request.tool_capabilities,
      request.tool_effect_status,
    ].some((item) => item !== null)) {
      throw new TypeError('Non-call MCP phases must not contain tool binding metadata');
    }
    return Object.freeze({ request, target });
  } catch (error) {
    if (error instanceof RiskForkMcpHostAdapterError) throw error;
    throw adapterError(
      RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.INVALID_REQUEST,
      'MCP enforcement request is invalid',
    );
  }
}

function createPlanRequest(request, clock) {
  const value = {
    schema: RISK_FORK_MCP_PHASE_PLAN_REQUEST_SCHEMA,
    plan_request_id: `risk-fork-mcp-plan:${randomUUID()}`,
    mcp_request_hash: request.request_hash,
    phase: request.phase,
    mcp_server_ref: request.mcp_server_ref,
    mcp_server_origin: request.mcp_server_origin,
    session_binding_hash: request.session_binding_hash,
    tool_name: request.tool_name,
    tool_descriptor_hash: request.tool_descriptor_hash,
    tool_annotations: request.tool_annotations,
    tool_capabilities: request.tool_capabilities,
    tool_effect_status: request.tool_effect_status,
    params: request.params,
    requested_at: requireIsoDate(clock(), 'Risk Fork MCP adapter clock result'),
    plan_request_hash: null,
  };
  value.plan_request_hash = sha256Ref(value);
  return deepFreeze(value);
}

function normalizePhasePlanRequest(planRequestValue) {
  const planRequest = boundedCanonicalClone(
    planRequestValue,
    'Risk Fork MCP phase plan request',
  );
  exactKeys(planRequest, [
    'schema',
    'plan_request_id',
    'mcp_request_hash',
    'phase',
    'mcp_server_ref',
    'mcp_server_origin',
    'session_binding_hash',
    'tool_name',
    'tool_descriptor_hash',
    'tool_annotations',
    'tool_capabilities',
    'tool_effect_status',
    'params',
    'requested_at',
    'plan_request_hash',
  ], 'Risk Fork MCP phase plan request');
  if (planRequest.schema !== RISK_FORK_MCP_PHASE_PLAN_REQUEST_SCHEMA
    || !ALL_PHASES.includes(planRequest.phase)
    || !safeEqual(
      planRequest.plan_request_hash,
      sha256Ref({ ...planRequest, plan_request_hash: null }),
    )) {
    throw new TypeError('Risk Fork MCP phase plan request is invalid');
  }
  return planRequest;
}

export function createRiskForkMcpChildOperation(planRequestValue, input = {}) {
  const planRequest = normalizePhasePlanRequest(planRequestValue);
  assertAllowedKeys(
    input,
    ['response_schema', 'max_response_bytes', 'timeout_ms'],
    'Risk Fork MCP child operation input',
  );
  const mcpResultSchema = boundedCanonicalClone(
    input.response_schema,
    'Risk Fork MCP result schema',
  );
  assertPlainObject(mcpResultSchema, 'Risk Fork MCP result schema');
  const responseSchema = transportResultSchema(mcpResultSchema);
  const destinationPolicy = createDestinationPolicy({
    href: planRequest.mcp_server_ref,
    origin: planRequest.mcp_server_origin,
  });
  const operation = {
    schema: RISK_FORK_MCP_CHILD_OPERATION_SCHEMA,
    kind: 'mcp_http_phase',
    mcp_request_hash: planRequest.mcp_request_hash,
    phase: planRequest.phase,
    mcp_server_ref: planRequest.mcp_server_ref,
    mcp_server_origin: planRequest.mcp_server_origin,
    tool_name: planRequest.tool_name,
    params: planRequest.params,
    protocol_version: MCP_PROTOCOL_VERSION,
    destination_policy: destinationPolicy,
    redirects: 'error',
    response_mode: 'json',
    mcp_result_schema: mcpResultSchema,
    mcp_result_schema_hash: sha256Ref(mcpResultSchema),
    response_schema: responseSchema,
    response_schema_hash: sha256Ref(responseSchema),
    max_response_bytes: boundedInteger(
      input.max_response_bytes ?? 256 * 1024,
      'Risk Fork MCP child max_response_bytes',
      { min: 1_024, max: MAX_CHILD_RESPONSE_BYTES },
    ),
    timeout_ms: boundedInteger(
      input.timeout_ms ?? 30_000,
      'Risk Fork MCP child timeout_ms',
      { min: 100, max: MAX_TIMEOUT_MS },
    ),
    operation_hash: null,
  };
  operation.operation_hash = sha256Ref(operation);
  return deepFreeze(operation);
}

export function createRiskForkMcpPhasePlan(planRequestValue, input = {}) {
  const planRequest = normalizePhasePlanRequest(planRequestValue);
  assertAllowedKeys(input, ['descriptor_ref', 'operation_input'], 'Risk Fork MCP phase plan input');
  const plan = {
    schema: RISK_FORK_MCP_PHASE_PLAN_SCHEMA,
    plan_request_hash: planRequest.plan_request_hash,
    mcp_request_hash: planRequest.mcp_request_hash,
    descriptor_ref: requireOpaqueRef(input.descriptor_ref, 'Risk Fork MCP phase plan descriptor_ref'),
    operation_input: boundedCanonicalClone(
      input.operation_input,
      'Risk Fork MCP phase plan operation_input',
    ),
    plan_hash: null,
  };
  plan.plan_hash = sha256Ref(plan);
  return deepFreeze(plan);
}

export function createTrustedRiskForkMcpPhasePlanSource(resolvePlan) {
  if (typeof resolvePlan !== 'function') {
    throw new TypeError('Trusted Risk Fork MCP phase plan source requires a host callback');
  }
  const source = Object.freeze({
    schema: 'agoragentic.risk-fork.trusted-mcp-phase-plan-source.v1',
    trust_mode: 'host_callback_identity',
  });
  planSourceResolvers.set(source, resolvePlan);
  return source;
}

function assertMcpChildOperationMatchesRequest(operation, planRequest, request) {
  exactKeys(operation, [
    'schema',
    'kind',
    'mcp_request_hash',
    'phase',
    'mcp_server_ref',
    'mcp_server_origin',
    'tool_name',
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
  ], 'Risk Fork MCP child operation');
  if (operation.schema !== RISK_FORK_MCP_CHILD_OPERATION_SCHEMA
    || operation.kind !== 'mcp_http_phase'
    || !safeEqual(operation.mcp_request_hash, request.request_hash)
    || !safeEqual(operation.mcp_request_hash, planRequest.mcp_request_hash)
    || operation.phase !== request.phase
    || operation.mcp_server_ref !== request.mcp_server_ref
    || operation.mcp_server_origin !== request.mcp_server_origin
    || operation.tool_name !== request.tool_name
    || !safeEqual(sha256Ref(operation.params), sha256Ref(request.params))
    || operation.protocol_version !== MCP_PROTOCOL_VERSION
    || !safeEqual(
      sha256Ref(operation.destination_policy),
      sha256Ref(createDestinationPolicy({
        href: request.mcp_server_ref,
        origin: request.mcp_server_origin,
      })),
    )
    || operation.redirects !== 'error'
    || operation.response_mode !== 'json'
    || !safeEqual(operation.mcp_result_schema_hash, sha256Ref(operation.mcp_result_schema))
    || !safeEqual(
      sha256Ref(operation.response_schema),
      sha256Ref(transportResultSchema(operation.mcp_result_schema)),
    )
    || !safeEqual(operation.response_schema_hash, sha256Ref(operation.response_schema))
    || !safeEqual(operation.operation_hash, sha256Ref({ ...operation, operation_hash: null }))) {
    throw adapterError(
      RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.PLAN_BINDING_MISMATCH,
      'Risk Fork MCP child operation does not bind the exact request',
    );
  }
  assertPlainObject(operation.params, 'Risk Fork MCP child operation.params');
  assertPlainObject(
    operation.destination_policy,
    'Risk Fork MCP child operation.destination_policy',
  );
  assertPlainObject(operation.mcp_result_schema, 'Risk Fork MCP child operation.mcp_result_schema');
  assertPlainObject(operation.response_schema, 'Risk Fork MCP child operation.response_schema');
  boundedInteger(
    operation.max_response_bytes,
    'Risk Fork MCP child operation.max_response_bytes',
    { min: 1_024, max: MAX_CHILD_RESPONSE_BYTES },
  );
  boundedInteger(
    operation.timeout_ms,
    'Risk Fork MCP child operation.timeout_ms',
    { min: 100, max: MAX_TIMEOUT_MS },
  );
}

function assertPlanMatchesRequest(
  planValue,
  planRequest,
  request,
  maxBytes,
  syntheticDemoMode,
) {
  try {
    const plan = boundedCanonicalClone(planValue, 'Risk Fork MCP phase plan', maxBytes);
    exactKeys(plan, [
      'schema',
      'plan_request_hash',
      'mcp_request_hash',
      'descriptor_ref',
      'operation_input',
      'plan_hash',
    ], 'Risk Fork MCP phase plan');
    if (plan.schema !== RISK_FORK_MCP_PHASE_PLAN_SCHEMA
      || !safeEqual(plan.plan_request_hash, planRequest.plan_request_hash)
      || !safeEqual(plan.mcp_request_hash, request.request_hash)
      || !safeEqual(plan.plan_hash, sha256Ref({ ...plan, plan_hash: null }))) {
      throw adapterError(
        RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.PLAN_BINDING_MISMATCH,
        'Risk Fork MCP phase plan does not bind the exact request',
      );
    }
    requireOpaqueRef(plan.descriptor_ref, 'Risk Fork MCP phase plan.descriptor_ref');
    exactKeys(plan.operation_input, OPERATION_INPUT_KEYS, 'Risk Fork MCP phase operation input');
    const operationInput = plan.operation_input;
    if (operationInput.expected_commit_type !== 'TYPED_RESULT') {
      throw new TypeError('MCP phase plans must authorize a typed result only');
    }
    const operation = assertPlainObject(
      operationInput.operation,
      'Risk Fork MCP phase child operation',
    );
    let operationMode;
    let expectedResultSchemaHash;
    if (operation.kind === 'mcp_http_phase') {
      assertMcpChildOperationMatchesRequest(operation, planRequest, request);
      const policy = networkPolicy(operationInput.network_policy);
      if (policy.mode !== 'allowlist'
        || policy.allowlist.length !== 1
        || policy.allowlist[0] !== request.mcp_server_ref) {
        throw new TypeError(
          'MCP child transport requires an exact one-endpoint network allowlist',
        );
      }
      operationMode = 'child_transport';
      expectedResultSchemaHash = operation.response_schema_hash;
    } else if (operation.kind === 'bounded_file_batch' && syntheticDemoMode === true) {
      if (operationInput.network_policy?.mode !== 'blocked') {
        throw new TypeError('Synthetic MCP demo plans require blocked child network');
      }
      const candidate = assertPlainObject(
        operation.commit_candidate,
        'Synthetic MCP demo commit candidate',
      );
      if (candidate.type !== 'TYPED_RESULT') {
        throw new TypeError('Synthetic MCP demo plans require a typed result candidate');
      }
      expectedResultSchemaHash = sha256Ref(candidate.payload_schema);
      operationMode = 'synthetic_demo';
    } else {
      throw new TypeError(
        'Live-default MCP plans require an exact child transport operation; predeclared results are demo-only',
      );
    }
    requireSha256Ref(
      operationInput.commit_policy?.typed_result_schema_hash,
      'Risk Fork MCP phase plan typed-result schema hash',
    );
    const capsule = assertPlainObject(operationInput.capsule, 'Risk Fork MCP phase plan capsule');
    const interaction = assertPlainObject(
      capsule.proposed_interaction,
      'Risk Fork MCP phase plan capsule interaction',
    );
    const normalizedOrigin = new URL(request.mcp_server_origin).toString();
    const expectedTargetRef = `mcp-request:${request.request_hash.slice(7)}`;
    if (interaction.mcp_server_ref !== request.mcp_server_ref
      || interaction.mcp_server_origin !== normalizedOrigin
      || interaction.mcp_method !== request.phase
      || interaction.raw_method !== null
      || interaction.tool_name !== request.tool_name
      || interaction.target_ref !== expectedTargetRef
      || !safeEqual(interaction.effective_arguments_hash, sha256Ref(request.params))
      || !safeEqual(sha256Ref(operationInput.effective_arguments), sha256Ref(request.params))
      || !Array.isArray(capsule.allowed_commit_types)
      || !capsule.allowed_commit_types.includes('TYPED_RESULT')
      || !safeEqual(
        capsule.authorized_result_schema_hash,
        operationInput.commit_policy.typed_result_schema_hash,
      )
      || !safeEqual(
        expectedResultSchemaHash,
        operationInput.commit_policy.typed_result_schema_hash,
      )) {
      throw adapterError(
        RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.PLAN_BINDING_MISMATCH,
        'Risk Fork MCP phase plan interaction does not match the exact request',
      );
    }
    return Object.freeze({ operationMode, plan });
  } catch (error) {
    if (error instanceof RiskForkMcpHostAdapterError) throw error;
    throw adapterError(
      RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.PLAN_INVALID,
      'Trusted Risk Fork MCP phase plan is invalid',
    );
  }
}

function cleanImportedEnvelope(request, validatedPlan, preparedResult) {
  try {
    const { operationMode, plan } = validatedPlan;
    if (preparedResult.authority_granted !== false
      || preparedResult.provider_handle_exposed !== false) {
      throw new TypeError('Host boundary exposed authority or a provider handle');
    }
    assertPreparedForCleanCommit(preparedResult.prepared);
    const prepared = preparedResult.prepared;
    const plannedInput = plan.operation_input;
    const plannedOperation = plannedInput.operation;
    const plannedCandidate = plannedOperation?.commit_candidate;
    const expectedPayloadSchemaHash = operationMode === 'child_transport'
      ? plannedOperation.response_schema_hash
      : sha256Ref(plannedCandidate?.payload_schema);
    const normalizedRisk = prepared.risk_decision?.normalized_input;
    const requiredLevel = request.risk_profile.minimum_level;
    const levelRank = { LOW: 0, ELEVATED: 1, HIGH: 2, IRREVERSIBLE: 3 };
    const expectedActions = {
      LOW: 'NORMAL_EXECUTION',
      ELEVATED: 'RISK_FORK_OPTIONAL',
      HIGH: 'RISK_FORK_REQUIRED',
      IRREVERSIBLE: 'RISK_FORK_PREPARE_CLEAN_COMMIT_REQUIRED',
    };
    const expectedTargetRef = `mcp-request:${request.request_hash.slice(7)}`;
    const expectedAnnotations = request.phase === 'tools/call'
      ? {
          read_only_hint: request.tool_annotations?.readOnlyHint === true,
          destructive_hint: request.tool_annotations?.destructiveHint === true,
          idempotent_hint: request.tool_annotations?.idempotentHint === true,
          open_world_hint: request.tool_annotations?.openWorldHint !== false,
        }
      : null;
    if (prepared.authority_granted !== false
      || prepared.artifact.commit_type !== 'TYPED_RESULT'
      || preparedResult.descriptor_ref !== plan.descriptor_ref
      || !safeEqual(preparedResult.operation_hash, sha256Ref(plannedInput))
      || !safeEqual(prepared.capsule.capsule_hash, plannedInput.capsule.capsule_hash)
      || prepared.capsule.proposed_interaction.target_ref !== expectedTargetRef
      || prepared.capsule.proposed_interaction.mcp_server_ref !== request.mcp_server_ref
      || prepared.capsule.proposed_interaction.mcp_server_origin
        !== new URL(request.mcp_server_origin).toString()
      || prepared.capsule.proposed_interaction.mcp_method !== request.phase
      || prepared.capsule.proposed_interaction.tool_name !== request.tool_name
      || !safeEqual(
        prepared.capsule.proposed_interaction.effective_arguments_hash,
        sha256Ref(request.params),
      )
      || (operationMode === 'synthetic_demo'
        && (plannedCandidate?.type !== 'TYPED_RESULT'
          || !safeEqual(
            prepared.artifact.body.payload_hash,
            sha256Ref(plannedCandidate.payload),
          )))
      || !safeEqual(prepared.artifact.body.payload_schema_hash, expectedPayloadSchemaHash)
      || !safeEqual(
        prepared.artifact.body.payload_schema_hash,
        plannedInput.commit_policy.typed_result_schema_hash,
      )
      || !normalizedRisk
      || normalizedRisk.mcp_phase !== request.phase
      || normalizedRisk.mcp_server_ref !== request.mcp_server_ref
      || normalizedRisk.mcp_server_origin !== new URL(request.mcp_server_origin).toString()
      || normalizedRisk.tool_name !== request.tool_name
      || !Number.isInteger(levelRank[prepared.risk_decision.level])
      || levelRank[prepared.risk_decision.level] < levelRank[requiredLevel]
      || prepared.risk_decision.action !== expectedActions[prepared.risk_decision.level]
      || !safeEqual(
        prepared.risk_decision.decision_hash,
        sha256Ref({ ...prepared.risk_decision, decision_hash: null }),
      )
      || prepared.risk_decision.blocked !== false) {
      throw new TypeError('Risk Fork prepared result is not an authority-free typed result');
    }
    if (request.phase === 'tools/call'
      && (!safeEqual(
        sha256Ref(normalizedRisk.capabilities),
        sha256Ref(Object.fromEntries(TOOL_CAPABILITY_KEYS.map((key) => [
          key,
          request.tool_capabilities[key] === true,
        ]))),
      )
        || !safeEqual(sha256Ref(normalizedRisk.tool_annotations), sha256Ref(expectedAnnotations)))) {
      throw new TypeError('Risk Fork prepared risk evidence does not match the bound remote tool');
    }
    const importedPayload = boundedCanonicalClone(
      prepared.artifact.body.payload,
      'Risk Fork MCP clean imported payload',
    );
    const result = operationMode === 'child_transport'
      ? verifyTransportResult(importedPayload, plannedOperation)
      : importedPayload;
    scanSecretValues(result, 'Risk Fork MCP clean imported payload');
    const evidenceRef = `risk-fork-mcp:${prepared.artifact.artifact_hash}`;
    const envelope = {
      schema: MCP_SCHEMAS.cleanImportedResult,
      request_id: request.request_id,
      request_hash: request.request_hash,
      phase: request.phase,
      clean_imported: true,
      authority_granted: false,
      evidence_ref: evidenceRef,
      evidence_hash: sha256Ref({
        evidence_ref: evidenceRef,
        request_hash: request.request_hash,
        result,
      }),
      result,
    };
    return deepFreeze(envelope);
  } catch {
    throw adapterError(
      RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.PREPARED_RESULT_INVALID,
      'Risk Fork did not return a verified authority-free typed result',
    );
  }
}

function throwIfAborted(context) {
  if (context?.signal?.aborted) {
    throw adapterError(
      RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.ABORTED,
      'Risk Fork MCP host operation was aborted before clean import',
    );
  }
}

async function executePhase(record, request, context) {
  throwIfAborted(context);
  if (request.risk_profile.minimum_level === 'IRREVERSIBLE'
    || request.risk_profile.prepare_only === true) {
    throw adapterError(
      RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.ACTION_PROPOSAL_REQUIRED,
      'Irreversible or unknown-effect MCP calls require a separately reviewed consequential action proposal',
    );
  }
  const planRequest = createPlanRequest(request, record.clock);
  let unresolvedPlan;
  try {
    unresolvedPlan = await record.resolvePlan(planRequest, context);
  } catch {
    throw adapterError(
      RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.PLAN_RESOLUTION_FAILED,
      'Trusted Risk Fork MCP phase plan source did not resolve the request',
    );
  }
  throwIfAborted(context);
  const validatedPlan = assertPlanMatchesRequest(
    unresolvedPlan,
    planRequest,
    request,
    record.maxRequestBytes,
    record.syntheticDemoMode,
  );
  let preparedResult;
  try {
    preparedResult = await record.preEffect({
      descriptor_ref: validatedPlan.plan.descriptor_ref,
      operation_input: validatedPlan.plan.operation_input,
    });
  } catch {
    throw adapterError(
      RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.PRE_EFFECT_REJECTED,
      'Risk Fork host boundary rejected the MCP phase before import',
    );
  }
  throwIfAborted(context);
  return cleanImportedEnvelope(request, validatedPlan, preparedResult);
}

function startBoundedPhase(record, request, context, configuredTimeoutMs) {
  const controller = new AbortController();
  const externalSignal = context?.signal;
  let timeoutMs = configuredTimeoutMs;
  const externalDeadline = Date.parse(context?.deadline_at ?? '');
  if (Number.isFinite(externalDeadline)) {
    timeoutMs = Math.max(1, Math.min(timeoutMs, externalDeadline - Date.now()));
  }
  if (Number.isSafeInteger(context?.timeout_ms) && context.timeout_ms > 0) {
    timeoutMs = Math.min(timeoutMs, context.timeout_ms);
  }
  let rejectGate;
  let settled = false;
  const gate = new Promise((_resolve, reject) => { rejectGate = reject; });
  const abortWith = (code, message, reason) => {
    if (settled) return;
    const error = adapterError(code, message);
    controller.abort(reason ?? error);
    rejectGate(error);
  };
  const onExternalAbort = () => abortWith(
    RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.ABORTED,
    'Risk Fork MCP host operation was aborted before clean import',
    externalSignal.reason,
  );
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => abortWith(
    RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.DEADLINE_EXCEEDED,
    'Risk Fork MCP host operation exceeded its bounded deadline',
  ), timeoutMs);
  const phaseContext = Object.freeze({
    signal: controller.signal,
    timeout_ms: timeoutMs,
    deadline_at: new Date(Date.now() + timeoutMs).toISOString(),
    operation: context?.operation ?? request.phase,
  });
  const terminal = Promise.resolve().then(() => executePhase(record, request, phaseContext));
  const cleanup = () => {
    settled = true;
    clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', onExternalAbort);
  };
  terminal.then(cleanup, cleanup);
  return Object.freeze({
    result: Promise.race([terminal, gate]),
    terminal,
  });
}

function normalizeTimeouts(value = {}) {
  assertAllowedKeys(value, Object.keys(DEFAULT_TIMEOUTS), 'Risk Fork MCP host timeouts');
  return Object.freeze(Object.fromEntries(Object.entries(DEFAULT_TIMEOUTS).map(([key, fallback]) => {
    const candidate = value[key] ?? fallback;
    if (!Number.isSafeInteger(candidate)
      || candidate < MIN_TIMEOUT_MS
      || candidate > MAX_TIMEOUT_MS) {
      throw new TypeError(`Risk Fork MCP host timeout ${key} is invalid`);
    }
    return [key, candidate];
  })));
}

export function createRiskForkMcpHostAdapter(input = {}) {
  assertAllowedKeys(input, [
    'host_boundary',
    'trusted_phase_plan_source',
    'clock',
    'timeouts',
    'max_sessions',
    'max_requests_per_session',
    'max_request_bytes',
    'synthetic_demo_mode',
  ], 'Risk Fork MCP host adapter input');
  if (!isRiskForkHostBoundary(input.host_boundary)) {
    throw adapterError(
      RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.INVALID_CONFIGURATION,
      'Risk Fork MCP host adapter requires an exact factory-created host boundary',
    );
  }
  const resolvePlan = planSourceResolvers.get(input.trusted_phase_plan_source);
  if (!resolvePlan) {
    throw adapterError(
      RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.PLAN_SOURCE_UNTRUSTED,
      'Risk Fork MCP host adapter requires an exact host-owned phase plan source capability',
    );
  }
  const clock = input.clock ?? (() => new Date());
  if (typeof clock !== 'function') throw new TypeError('Risk Fork MCP adapter clock is invalid');
  const timeouts = normalizeTimeouts(input.timeouts ?? {});
  const maxSessions = boundedInteger(input.max_sessions ?? 16, 'max_sessions', { min: 1, max: 1_000 });
  const maxRequestsPerSession = boundedInteger(
    input.max_requests_per_session ?? 100,
    'max_requests_per_session',
    { min: 1, max: 10_000 },
  );
  const maxRequestBytes = boundedInteger(
    input.max_request_bytes ?? MAX_PLAN_BYTES,
    'max_request_bytes',
    { min: 1_024, max: MAX_PLAN_BYTES },
  );
  if (input.synthetic_demo_mode !== undefined
    && typeof input.synthetic_demo_mode !== 'boolean') {
    throw new TypeError('synthetic_demo_mode must be a boolean');
  }
  const syntheticDemoMode = input.synthetic_demo_mode === true;
  const sessions = new Set();
  const runtime = { pendingOpens: 0 };
  const preEffect = input.host_boundary.preEffect.bind(input.host_boundary);

  async function openSession(openRequestValue, context = {}) {
    if (sessions.size + runtime.pendingOpens >= maxSessions) {
      throw adapterError(
        RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.SESSION_LIMIT,
        'Risk Fork MCP host session limit reached',
      );
    }
    runtime.pendingOpens += 1;
    let pendingReleased = false;
    const releasePendingOpen = () => {
      if (pendingReleased) return;
      pendingReleased = true;
      runtime.pendingOpens -= 1;
    };
    let openRequest;
    let discovery;
    let phaseOperation = null;
    try {
      ({ request: openRequest } = normalizeEnforcementRequest(openRequestValue, {
        expectedSchema: MCP_SCHEMAS.sessionOpenRequest,
        allowedPhases: [OPEN_PHASE],
        maxBytes: maxRequestBytes,
      }));
      phaseOperation = startBoundedPhase(
        adapterRecords.get(adapter),
        openRequest,
        context,
        timeouts.open_session_ms,
      );
      discovery = await phaseOperation.result;
    } catch (error) {
      if (!phaseOperation) releasePendingOpen();
      else phaseOperation.terminal.then(releasePendingOpen, releasePendingOpen);
      throw error;
    }
    try {
      exactKeys(discovery.result, ['protocol_version', 'stateless'], 'Risk Fork MCP discovery result');
      if (discovery.result.protocol_version !== MCP_PROTOCOL_VERSION
        || discovery.result.stateless !== true) {
        throw adapterError(
          RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.PREPARED_RESULT_INVALID,
          'Risk Fork MCP discovery did not establish the required stateless protocol',
        );
      }
      throwIfAborted(context);
      const sessionBindingHash = sha256Ref({
        open_request_hash: openRequest.request_hash,
        discovery_evidence_hash: discovery.evidence_hash,
        discovery_result_hash: sha256Ref(discovery.result),
        protocol_version: discovery.result.protocol_version,
        stateless: discovery.result.stateless,
      });
      const state = {
        closed: false,
        closePromise: null,
        currentRequest: null,
        requestCount: 0,
        seenRequestHashes: new Set(),
        serverRef: openRequest.mcp_server_ref,
        serverOrigin: openRequest.mcp_server_origin,
        sessionBindingHash,
      };
      let session;

      async function close() {
        if (state.closePromise) return state.closePromise;
        state.closed = true;
        const pendingAtClose = state.currentRequest;
        state.closePromise = (async () => {
          if (pendingAtClose) await pendingAtClose.terminal.catch(() => {});
          if (state.currentRequest === pendingAtClose) state.currentRequest = null;
          sessions.delete(session);
        })();
        return state.closePromise;
      }

      async function request(phaseRequestValue, phaseContext = {}) {
        if (state.closed) {
          throw adapterError(
            RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.SESSION_CLOSED,
            'Risk Fork MCP host session is closed',
          );
        }
        let normalized;
        try {
          normalized = normalizeEnforcementRequest(phaseRequestValue, {
            expectedSchema: MCP_SCHEMAS.phaseRequest,
            allowedPhases: REQUEST_PHASES,
            maxBytes: maxRequestBytes,
          }).request;
          if (normalized.mcp_server_ref !== state.serverRef
            || normalized.mcp_server_origin !== state.serverOrigin
            || !safeEqual(normalized.session_binding_hash, state.sessionBindingHash)) {
            throw adapterError(
              RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.SESSION_BINDING_MISMATCH,
              'MCP phase request does not match the enforced host session',
            );
          }
          if (state.seenRequestHashes.has(normalized.request_hash)) {
            throw adapterError(
              RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.REQUEST_REPLAY,
              'MCP phase request hash was already consumed',
            );
          }
          if (state.currentRequest) {
            throw adapterError(
              RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.REQUEST_CONCURRENT,
              'Concurrent MCP phase requests are not accepted by this source adapter',
            );
          }
          if (state.requestCount >= maxRequestsPerSession) {
            throw adapterError(
              RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.REQUEST_LIMIT,
              'Risk Fork MCP host request limit reached',
            );
          }
          state.requestCount += 1;
          state.seenRequestHashes.add(normalized.request_hash);
          const pending = startBoundedPhase(
            adapterRecords.get(adapter),
            normalized,
            phaseContext,
            timeouts.request_ms,
          );
          state.currentRequest = pending;
          const envelope = await pending.result;
          if (state.closed) {
            throw adapterError(
              RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.SESSION_CLOSED,
              'Risk Fork MCP host session closed before clean import',
            );
          }
          if (state.currentRequest === pending) state.currentRequest = null;
          return envelope;
        } catch (error) {
          void close().catch(() => {});
          throw error;
        }
      }

      session = Object.freeze({
        schema: MCP_SCHEMAS.hostSession,
        discovery,
        request,
        close,
      });
      sessions.add(session);
      releasePendingOpen();
      return session;
    } catch (error) {
      releasePendingOpen();
      throw error;
    }
  }

  async function executeFallback() {
    throw adapterError(
      RISK_FORK_MCP_HOST_DIAGNOSTIC_CODES.FALLBACK_BLOCKED,
      'Risk Fork MCP source adapter does not expose an HTTP fallback or direct transport',
    );
  }

  const adapter = Object.freeze({ openSession, executeFallback, timeouts });
  adapterRecords.set(adapter, Object.freeze({
    schema: RISK_FORK_MCP_HOST_ADAPTER_SCHEMA,
    clock,
    maxRequestBytes,
    preEffect,
    resolvePlan,
    syntheticDemoMode,
  }));
  return adapter;
}

export function isRiskForkMcpHostAdapter(value) {
  return adapterRecords.has(value);
}
