import path from 'node:path';
import { isDeepStrictEqual, types as utilTypes } from 'node:util';

import { containsSerializedCredentialMaterial, deepFreeze, requireSha256Ref } from './util.mjs';

export const RISK_FORK_CLIENT_ADOPTION_SCHEMA =
  'agoragentic.risk-fork.client-adoption-packet.v1';
export const RISK_FORK_GATEWAY_TOOL = 'risk_fork_protect';
export const RISK_FORK_CLIENT_GATE_MAX_GATEWAY_BYTES = 4 * 1024 * 1024;
export const RISK_FORK_CLIENTS = Object.freeze(['claude-code', 'codex', 'cursor']);

const SERVER_NAME = 'risk_fork';
const SOURCE_STATUS = 'source_only_default_off';
const GATEWAY_STATUS = 'diagnostic_only_refuses_standalone_startup';
const MAX_PACKET_DEPTH = 32;
const MAX_PACKET_NODES = 5_000;
const MAX_PACKET_STRING_BYTES = 4 * 1024 * 1024;
const MAX_PACKET_UTF8_BYTES = 8 * 1024 * 1024;
const issuedPackets = new WeakSet();

function fail(message) {
  const error = new TypeError(message);
  error.code = 'RISK_FORK_CLIENT_ADOPTION_INVALID';
  return error;
}

function readExactOptions(options) {
  if (options === null
    || typeof options !== 'object'
    || Array.isArray(options)
    || utilTypes.isProxy(options)) {
    throw fail('Client-adoption options must be a plain data-only object');
  }

  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(options);
    descriptors = Object.getOwnPropertyDescriptors(options);
  } catch {
    throw fail('Client-adoption options must be a plain data-only object');
  }
  if (prototype !== Object.prototype) {
    throw fail('Client-adoption options must use Object.prototype');
  }

  const allowed = [
    'client',
    'gateEntrypoint',
    'gateSha256',
    'gatewayEntrypoint',
    'gatewaySha256',
    'nodeExecutable',
  ];
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== allowed.length || allowed.some((key) => !keys.includes(key))) {
    throw fail(`Client-adoption options must contain exactly: ${allowed.join(', ')}`);
  }

  const values = {};
  for (const key of allowed) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw fail(`Client-adoption option ${key} must be a data property`);
    }
    values[key] = descriptor.value;
  }
  return values;
}

function requireClient(value) {
  const supported = value === 'claude-code' || value === 'codex' || value === 'cursor';
  if (value !== 'all' && !supported) {
    throw fail(`client must be one of: all, ${RISK_FORK_CLIENTS.join(', ')}`);
  }
  return value;
}

function requireAbsoluteFile(value, field, basename) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 4096
    || !path.isAbsolute(value)
    || path.basename(value) !== basename
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw fail(`${field} must be an absolute path ending in ${basename}`);
  }
  const normalized = path.normalize(value);
  if (containsSerializedCredentialMaterial(normalized)) {
    throw fail(`${field} must not contain credential-shaped material`);
  }
  return normalized;
}

function assertOrdinaryPacketTree(value) {
  const seen = new WeakSet();
  let nodes = 0;
  let utf8Bytes = 0;

  function accountUtf8Bytes(current) {
    const bytes = Buffer.byteLength(current, 'utf8');
    if (bytes > MAX_PACKET_UTF8_BYTES - utf8Bytes) {
      throw fail('Client-adoption packet exceeds the aggregate UTF-8 verification limit');
    }
    utf8Bytes += bytes;
    return bytes;
  }

  function walk(current, depth) {
    nodes += 1;
    if (nodes > MAX_PACKET_NODES || depth > MAX_PACKET_DEPTH) {
      throw fail('Client-adoption packet exceeds the deterministic verification limit');
    }
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'string') {
      if (accountUtf8Bytes(current) > MAX_PACKET_STRING_BYTES) {
        throw fail('Client-adoption packet contains an oversized string');
      }
      return;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0) || !Number.isSafeInteger(current)) {
        throw fail('Client-adoption packet contains an invalid number');
      }
      return;
    }
    if (typeof current !== 'object' || utilTypes.isProxy(current) || seen.has(current)) {
      throw fail('Client-adoption packet must contain only ordinary, unshared JSON values');
    }
    seen.add(current);
    const isArray = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if ((isArray && prototype !== Array.prototype)
      || (!isArray && prototype !== Object.prototype)) {
      throw fail('Client-adoption packet contains a non-plain value');
    }
    if (Object.getOwnPropertySymbols(current).length !== 0) {
      throw fail('Client-adoption packet contains a symbol key');
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const keys = Object.keys(descriptors);
    for (const key of keys) {
      if (isArray && key === 'length') continue;
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || descriptor.get || descriptor.set) {
        throw fail('Client-adoption packet contains a non-data property');
      }
      accountUtf8Bytes(key);
    }
    if (isArray) {
      if (Object.keys(current).length !== current.length) {
        throw fail('Client-adoption packet contains a sparse or extended array');
      }
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
          throw fail('Client-adoption packet contains a sparse array');
        }
        walk(descriptor.value, depth + 1);
      }
      return;
    }
    for (const key of keys) walk(descriptors[key].value, depth + 1);
  }

  walk(value, 0);
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function tomlString(value) {
  return JSON.stringify(value);
}

function gatewayArgs({ gateEntrypoint, gatewayEntrypoint, gatewaySha256 }) {
  return [
    gateEntrypoint,
    'serve',
    '--gateway-entrypoint',
    gatewayEntrypoint,
    '--gateway-sha256',
    gatewaySha256,
  ];
}

function codexOutput(options) {
  const content = [
    '# Risk Fork source-only client packet. Disabled by default.',
    `# gate_sha256 = ${options.gateSha256}`,
    `# gateway_sha256 = ${options.gatewaySha256}`,
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(options.nodeExecutable)}`,
    `args = [${gatewayArgs(options).map(tomlString).join(', ')}]`,
    'enabled = false',
    'required = true',
    'default_tools_approval_mode = "prompt"',
    `enabled_tools = [${tomlString(RISK_FORK_GATEWAY_TOOL)}]`,
    '',
    `[mcp_servers.${SERVER_NAME}.tools.${RISK_FORK_GATEWAY_TOOL}]`,
    'approval_mode = "prompt"',
    '',
  ].join('\n');
  return {
    client: 'codex',
    format: 'toml',
    review_filename: 'codex-risk-fork.disabled.toml',
    active_destination: '$CODEX_HOME/config.toml or a trusted project .codex/config.toml',
    content,
    native_default_off: true,
    native_exact_tool_allowlist: true,
    prompt_posture: 'explicit_per_tool_prompt',
  };
}

function claudeOutputs(options) {
  return [
    {
      client: 'claude-code',
      format: 'json',
      review_filename: 'claude-code-risk-fork.disabled.mcp.json',
      active_destination: 'project .mcp.json',
      content: json({
        mcpServers: {
          [SERVER_NAME]: {
            type: 'stdio',
            command: options.nodeExecutable,
            args: gatewayArgs(options),
            env: {},
          },
        },
      }),
      native_default_off: false,
      native_exact_tool_allowlist: false,
      prompt_posture: 'not_configured_in_this_file',
    },
    {
      client: 'claude-code',
      format: 'json',
      review_filename: 'claude-code-risk-fork.disabled.settings.json',
      active_destination: 'project .claude/settings.json after an explicit reviewed merge',
      content: json({
        disabledMcpjsonServers: [SERVER_NAME],
        permissions: {
          ask: [`mcp__${SERVER_NAME}__${RISK_FORK_GATEWAY_TOOL}`],
        },
      }),
      native_default_off: true,
      native_exact_tool_allowlist: false,
      prompt_posture: 'explicit_ask_rule_while_server_disabled',
    },
  ];
}

function cursorOutputs(options) {
  return [
    {
      client: 'cursor',
      format: 'json',
      review_filename: 'cursor-risk-fork.disabled.mcp.json',
      active_destination: 'project .cursor/mcp.json',
      content: json({
        mcpServers: {
          [SERVER_NAME]: {
            type: 'stdio',
            command: options.nodeExecutable,
            args: gatewayArgs(options),
            env: {},
          },
        },
      }),
      native_default_off: false,
      native_exact_tool_allowlist: false,
      prompt_posture: 'client_default_only',
    },
    {
      client: 'cursor',
      format: 'json',
      review_filename: 'cursor-risk-fork.disabled.permissions.json',
      active_destination: 'project .cursor/permissions.json after an explicit reviewed merge',
      content: json({
        mcpAllowlist: [],
        autoRun: {
          block_instructions: [
            `Require explicit approval for ${SERVER_NAME}:${RISK_FORK_GATEWAY_TOOL}.`,
          ],
        },
      }),
      native_default_off: false,
      native_exact_tool_allowlist: false,
      prompt_posture: 'empty_workspace_allowlist_best_effort_block',
    },
  ];
}

function outputsFor(client, options) {
  if (client === 'codex') return [codexOutput(options)];
  if (client === 'claude-code') return claudeOutputs(options);
  if (client === 'cursor') return cursorOutputs(options);
  return [
    ...claudeOutputs(options),
    codexOutput(options),
    ...cursorOutputs(options),
  ];
}

export function createRiskForkClientAdoptionPacket(rawOptions) {
  const options = readExactOptions(rawOptions);
  const client = requireClient(options.client);
  const normalized = {
    client,
    nodeExecutable: requireAbsoluteFile(
      options.nodeExecutable,
      'nodeExecutable',
      path.basename(process.execPath),
    ),
    gateEntrypoint: requireAbsoluteFile(
      options.gateEntrypoint,
      'gateEntrypoint',
      'one-tool-stdio-gate.mjs',
    ),
    gateSha256: requireSha256Ref(options.gateSha256, 'gateSha256'),
    gatewayEntrypoint: requireAbsoluteFile(
      options.gatewayEntrypoint,
      'gatewayEntrypoint',
      'risk-forkd.js',
    ),
    gatewaySha256: requireSha256Ref(options.gatewaySha256, 'gatewaySha256'),
  };
  if (normalized.nodeExecutable !== path.normalize(process.execPath)) {
    throw fail('nodeExecutable must equal the current absolute Node.js executable');
  }

  const packet = deepFreeze({
    schema: RISK_FORK_CLIENT_ADOPTION_SCHEMA,
    status: SOURCE_STATUS,
    client,
    server_name: SERVER_NAME,
    expected_tool_inventory: [RISK_FORK_GATEWAY_TOOL],
    gateway: {
      gate_entrypoint: normalized.gateEntrypoint,
      gate_sha256: normalized.gateSha256,
      gateway_entrypoint: normalized.gatewayEntrypoint,
      gateway_sha256: normalized.gatewaySha256,
      standalone_status: GATEWAY_STATUS,
      exact_gateway_tool_enforced_by_local_gate: true,
      runtime_closure_bound: false,
      tool_input_schema_owner: 'future_risk-forkd_gateway',
      tool_input_schema_bound: false,
    },
    outputs: outputsFor(client, normalized),
    controls: {
      writes_performed: false,
      client_configuration_modified: false,
      client_enabled: false,
      activation_supported: false,
      provider_authority_granted: false,
      executor_bound: false,
      hosted_authority_granted: false,
      production_authority_granted: false,
      live_traffic_protected: false,
      credentials_included: false,
      provider_calls: 0,
      network_used: false,
    },
  });
  issuedPackets.add(packet);
  return packet;
}

export function verifyRiskForkClientAdoptionPacket(value) {
  assertOrdinaryPacketTree(value);
  if (!value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !value.gateway
    || typeof value.gateway !== 'object'
    || Array.isArray(value.gateway)) {
    throw fail('Client-adoption packet must contain its canonical gateway binding');
  }

  let expected;
  try {
    expected = createRiskForkClientAdoptionPacket({
      client: value.client,
      gateEntrypoint: value.gateway.gate_entrypoint,
      gateSha256: value.gateway.gate_sha256,
      gatewayEntrypoint: value.gateway.gateway_entrypoint,
      gatewaySha256: value.gateway.gateway_sha256,
      nodeExecutable: process.execPath,
    });
  } catch {
    throw fail('Client-adoption packet does not contain a valid canonical gateway binding');
  }
  if (!isDeepStrictEqual(value, expected)) {
    throw fail(
      'Client-adoption packet does not match the exact canonical client, output inventory, content, paths, posture, and default-off controls',
    );
  }
  return true;
}

export function isRiskForkClientAdoptionPacket(value) {
  return Boolean(value && typeof value === 'object' && issuedPackets.has(value));
}
