import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RISK_FORK_DEMO_BANNER,
  assertDemoSecretFree,
  assertDemoTruth,
  createDemoTruth,
  resolveOwnedDemoPath,
} from './security.mjs';

export const DEMO_CLIENTS = Object.freeze(['generic', 'codex', 'claude', 'cursor']);
export const GENERATED_NOT_CLIENT_VERIFIED_STATUS = 'generated_not_client_verified';

export const DEMO_CLIENT_VERIFICATION_DETAILS = Object.freeze({
  generic: 'generic_stdio_protocol_shape_tested_no_named_client_verified',
  codex: 'codex_config_generated_not_live_client_verified',
  claude: 'claude_desktop_config_generated_not_live_client_verified',
  cursor: 'cursor_config_generated_not_live_client_verified',
});

const issuedConfigurations = new WeakSet();
const expectedDemoEntrypoint = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'bin',
  'risk-fork-demo.mjs',
);

function assertIssuedConfiguration(configuration) {
  if (!configuration || typeof configuration !== 'object' || !issuedConfigurations.has(configuration)) {
    throw new TypeError('A module-issued demo client configuration is required');
  }
  return configuration;
}

function validateClient(client) {
  if (typeof client !== 'string' || !DEMO_CLIENTS.includes(client)) {
    throw new TypeError(`Unknown client. Allowed: ${DEMO_CLIENTS.join(', ')}`);
  }
  return client;
}

function assertAbsoluteEntrypoint(entrypoint) {
  if (typeof entrypoint !== 'string' || !path.isAbsolute(entrypoint)) {
    throw new TypeError('Demo entrypoint must be an absolute local path');
  }
  if (!entrypoint.endsWith('.mjs')) throw new TypeError('Demo entrypoint must be an .mjs file');
  if (entrypoint !== expectedDemoEntrypoint) {
    throw new TypeError('Demo entrypoint must be the exact local Risk Fork controller');
  }
  return entrypoint;
}

function jsonConfig(entrypoint, client) {
  const value = {
    _risk_fork_demo_notice: RISK_FORK_DEMO_BANNER,
    _verification_status: GENERATED_NOT_CLIENT_VERIFIED_STATUS,
    _verification_detail: DEMO_CLIENT_VERIFICATION_DETAILS[client],
    mcpServers: {
      risk_fork_demo: {
        command: 'node',
        args: [entrypoint, 'mcp'],
      },
    },
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}

function tomlString(value) {
  return JSON.stringify(value);
}

function codexConfig(entrypoint) {
  return [
    `# ${RISK_FORK_DEMO_BANNER}`,
    `# verification_status = "${GENERATED_NOT_CLIENT_VERIFIED_STATUS}"`,
    `# verification_detail = "${DEMO_CLIENT_VERIFICATION_DETAILS.codex}"`,
    '[mcp_servers.risk_fork_demo]',
    'command = "node"',
    `args = [${tomlString(entrypoint)}, "mcp"]`,
    'enabled = true',
    'required = false',
    'default_tools_approval_mode = "prompt"',
    'enabled_tools = ["risk_fork_demo_list_scenarios", "risk_fork_demo_plan", "risk_fork_demo_run", "risk_fork_demo_receipt"]',
    '',
  ].join('\n');
}

export function generateClientConfiguration({ client, entrypoint }) {
  const normalizedClient = validateClient(client);
  const absoluteEntrypoint = assertAbsoluteEntrypoint(entrypoint);
  const content = normalizedClient === 'codex'
    ? codexConfig(absoluteEntrypoint)
    : jsonConfig(absoluteEntrypoint, normalizedClient);
  assertDemoSecretFree(content, 'generated client configuration', {
    allowedAbsolutePaths: [absoluteEntrypoint],
  });
  if (/\bnpx(?:\.cmd)?\b/i.test(content) || /agoragentic-mcp/i.test(content)) {
    throw new Error('Generated Risk Fork configuration must not use the legacy registry relay');
  }
  const generated = Object.freeze({
    schema: 'agoragentic.risk-fork.demo-client-config.v1',
    banner: RISK_FORK_DEMO_BANNER,
    client: normalizedClient,
    verification_status: GENERATED_NOT_CLIENT_VERIFIED_STATUS,
    verification_detail: DEMO_CLIENT_VERIFICATION_DETAILS[normalizedClient],
    format: normalizedClient === 'codex' ? 'toml' : 'json',
    filename: normalizedClient === 'codex'
      ? 'codex-risk-fork-demo.toml'
      : `${normalizedClient}-risk-fork-demo.json`,
    command: 'node',
    args: Object.freeze([absoluteEntrypoint, 'mcp']),
    content,
    writes_performed: false,
  });
  issuedConfigurations.add(generated);
  return generated;
}

export async function writeClientConfiguration(rootHandle, generated, { yes = false } = {}) {
  assertIssuedConfiguration(generated);
  if (yes !== true) return generated;
  const directory = await resolveOwnedDemoPath(rootHandle, 'configs');
  if (!directory.exists) await mkdir(directory.absolute_path, { recursive: false });
  await resolveOwnedDemoPath(rootHandle, 'configs', {
    mustExist: true,
    expectedType: 'directory',
  });
  const target = await resolveOwnedDemoPath(rootHandle, `configs/${generated.filename}`);
  await writeFile(target.absolute_path, generated.content, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  const written = Object.freeze({
    ...generated,
    content: generated.content,
    output_ref: `owned-demo-root:${target.relative_path}`,
    writes_performed: true,
  });
  issuedConfigurations.add(written);
  return written;
}

export function createClientConfigurationResult(configuration, mode) {
  assertIssuedConfiguration(configuration);
  const expectedMode = configuration.writes_performed
    ? 'written_to_owned_demo_root'
    : 'preview';
  if (mode !== expectedMode) {
    throw new TypeError('Demo client configuration result mode does not match its write state');
  }
  if (
    configuration.writes_performed
    && configuration.output_ref !== `owned-demo-root:configs/${configuration.filename}`
  ) {
    throw new TypeError('Written demo client configuration is missing its exact owned-root reference');
  }
  const truth = createDemoTruth({
    schema: 'agoragentic.risk-fork.demo-config-result.v1',
    mode,
    writes_performed: configuration.writes_performed,
    exit_code: 0,
  });
  const result = Object.freeze({ ...truth, configuration });
  assertClientConfigurationResult(result);
  return result;
}

function assertClientConfigurationResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('A demo client configuration result is required');
  }
  const { configuration, ...truth } = result;
  assertIssuedConfiguration(configuration);
  assertDemoTruth(truth);
  const expectedMode = configuration.writes_performed
    ? 'written_to_owned_demo_root'
    : 'preview';
  if (
    result.schema !== 'agoragentic.risk-fork.demo-config-result.v1'
    || result.mode !== expectedMode
    || result.writes_performed !== configuration.writes_performed
    || result.exit_code !== 0
  ) {
    throw new TypeError('Demo client configuration result does not match its issued configuration');
  }
  const absoluteEntrypoint = configuration.args[0];
  assertDemoSecretFree(result, 'generated client configuration result', {
    allowedAbsolutePaths: [absoluteEntrypoint],
  });
  return true;
}
