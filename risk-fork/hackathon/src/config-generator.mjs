import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  RISK_FORK_DEMO_BANNER,
  assertDemoSecretFree,
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
  return path.resolve(entrypoint);
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
  assertDemoSecretFree(content, 'generated client configuration');
  if (/\bnpx(?:\.cmd)?\b/i.test(content) || /agoragentic-mcp/i.test(content)) {
    throw new Error('Generated Risk Fork configuration must not use the legacy registry relay');
  }
  return Object.freeze({
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
}

export async function writeClientConfiguration(rootHandle, generated, { yes = false } = {}) {
  if (!generated || generated.schema !== 'agoragentic.risk-fork.demo-client-config.v1') {
    throw new TypeError('A generated demo client configuration is required');
  }
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
  return Object.freeze({
    ...generated,
    content: generated.content,
    output_ref: `owned-demo-root:${target.relative_path}`,
    writes_performed: true,
  });
}
