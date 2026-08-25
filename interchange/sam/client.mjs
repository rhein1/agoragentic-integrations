#!/usr/bin/env node

import { readFile as readFileDefault } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { hashRef, normalizeSamTool, parseSamToolName } from './normalize.mjs';

export const DEFAULT_SAM_MCP_URL = 'http://127.0.0.1:8080/mcp';

const MAX_SAM_TOKEN_BYTES = 16_384;
const MAX_SAM_TOOL_RESULT_BYTES = 1_048_576;
const MAX_SAM_DISCOVERY_ROWS = 512;

export class SamClientError extends Error {
  constructor(code, message, { status = 500, retryable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SamClientError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLoopback(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (host.startsWith('::ffff:127.')) return true;
  const parts = host.split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function validateSamEndpoint(endpoint = DEFAULT_SAM_MCP_URL, { allowRemote = false } = {}) {
  let url;
  try {
    url = new URL(endpoint);
  } catch (cause) {
    throw new SamClientError('sam_endpoint_invalid', 'SAM MCP endpoint must be an absolute URL.', {
      status: 400,
      cause,
    });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new SamClientError('sam_endpoint_protocol_invalid', 'SAM MCP endpoint must use HTTP or HTTPS.', { status: 400 });
  }
  if (url.username || url.password) {
    throw new SamClientError('sam_endpoint_credentials_forbidden', 'Do not embed credentials in the SAM endpoint URL.', { status: 400 });
  }
  const local = isLoopback(url.hostname);
  if (!local && !allowRemote) {
    throw new SamClientError(
      'sam_remote_endpoint_requires_opt_in',
      'Only loopback SAM endpoints are accepted by default. Set allowRemote only for an operator-approved endpoint.',
      { status: 403 },
    );
  }
  if (!local && url.protocol !== 'https:') {
    throw new SamClientError('sam_remote_endpoint_requires_https', 'An opted-in remote SAM endpoint must use HTTPS.', { status: 400 });
  }
  return url;
}

export async function resolveSamToken(options = {}, dependencies = {}) {
  const env = dependencies.env || process.env;
  const readFile = dependencies.readFile || readFileDefault;
  const explicitToken = String(options.token || '').trim();
  const explicitTokenPath = String(options.tokenPath || '').trim();
  const envToken = String(env.SAM_API_TOKEN || '').trim();
  const envTokenPath = String(env.SAM_API_TOKEN_PATH || '').trim();
  if (explicitToken && explicitTokenPath) {
    throw new SamClientError('sam_token_source_ambiguous', 'Provide token or tokenPath, not both.', { status: 400 });
  }
  if (!explicitToken && !explicitTokenPath && envToken && envTokenPath) {
    throw new SamClientError(
      'sam_token_source_ambiguous',
      'Set SAM_API_TOKEN or SAM_API_TOKEN_PATH, not both.',
      { status: 400 },
    );
  }
  let token = explicitToken || (explicitTokenPath ? '' : envToken);
  const tokenPath = explicitTokenPath || (!token ? envTokenPath : '');
  if (!token && tokenPath) {
    let bytes;
    try {
      bytes = await readFile(tokenPath);
    } catch (cause) {
      throw new SamClientError('sam_token_file_unreadable', 'The configured SAM API token file could not be read.', {
        status: 401,
        cause,
      });
    }
    if (bytes.length > MAX_SAM_TOKEN_BYTES) {
      throw new SamClientError('sam_token_file_too_large', 'The configured SAM API token file is unexpectedly large.', { status: 400 });
    }
    token = bytes.toString('utf8').trim();
  }
  if (Buffer.byteLength(token, 'utf8') > MAX_SAM_TOKEN_BYTES) {
    throw new SamClientError('sam_token_too_large', 'The configured SAM API token is unexpectedly large.', { status: 400 });
  }
  if (token && /\s/.test(token)) {
    throw new SamClientError('sam_token_invalid', 'The SAM API token contains whitespace and was rejected.', { status: 400 });
  }
  return token || null;
}

export function authenticatedFetch(token, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new SamClientError('fetch_unavailable', 'A Fetch API implementation is required.');
  }
  return async (input, init = {}) => {
    const inherited = typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined;
    const headers = new Headers(init.headers || inherited || undefined);
    if (token) headers.set('X-Sam-Authentication', `Bearer ${token}`);
    return fetchImpl(input, { ...init, headers, redirect: 'error' });
  };
}

async function defaultClientFactory({ endpoint, token, fetchImpl }) {
  let sdk;
  try {
    sdk = await import('@modelcontextprotocol/client');
  } catch (cause) {
    throw new SamClientError(
      'mcp_client_dependency_missing',
      'Install @modelcontextprotocol/client before connecting to a SAM node.',
      { cause },
    );
  }
  const client = new sdk.Client({ name: 'agoragentic-sam-capture', version: '0.1.0' });
  const transport = new sdk.StreamableHTTPClientTransport(endpoint, {
    fetch: authenticatedFetch(token, fetchImpl),
  });
  await client.connect(transport);
  return client;
}

function parseTextResult(result, toolName) {
  const texts = (result?.content || [])
    .filter((entry) => entry?.type === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text);
  if (result?.isError) {
    throw new SamClientError('sam_tool_error', `SAM tool ${toolName} returned an error.`, {
      status: 502,
      retryable: true,
    });
  }
  const textBytes = texts.reduce((total, text) => total + Buffer.byteLength(text, 'utf8'), 0);
  if (textBytes > MAX_SAM_TOOL_RESULT_BYTES) {
    throw new SamClientError('sam_tool_result_too_large', `SAM tool ${toolName} returned too much text.`, {
      status: 502,
    });
  }
  if (result?.structuredContent !== undefined) {
    let serialized;
    try {
      serialized = JSON.stringify(result.structuredContent);
    } catch (cause) {
      throw new SamClientError('sam_tool_result_invalid', `SAM tool ${toolName} returned invalid structured content.`, {
        status: 502,
        cause,
      });
    }
    if (Buffer.byteLength(serialized || '', 'utf8') > MAX_SAM_TOOL_RESULT_BYTES) {
      throw new SamClientError('sam_tool_result_too_large', `SAM tool ${toolName} returned too much structured content.`, {
        status: 502,
      });
    }
    return result.structuredContent;
  }
  if (!texts.length) return null;
  if (texts.length === 1) {
    try {
      return JSON.parse(texts[0]);
    } catch {
      return texts[0];
    }
  }
  return texts.map((text) => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  });
}

async function callTool(client, name, args = {}) {
  try {
    return parseTextResult(await client.callTool({ name, arguments: args }), name);
  } catch (error) {
    if (error instanceof SamClientError) throw error;
    throw new SamClientError('sam_tool_call_failed', `SAM tool ${name} could not be called.`, {
      status: 502,
      retryable: true,
      cause: error,
    });
  }
}

async function withClient(options, dependencies, work) {
  const env = dependencies.env || process.env;
  const endpoint = validateSamEndpoint(
    options.endpoint || env.SAM_MCP_URL || DEFAULT_SAM_MCP_URL,
    { allowRemote: options.allowRemote === true },
  );
  const token = await resolveSamToken(options, dependencies);
  const injected = dependencies.client;
  const client = injected || await (dependencies.clientFactory || defaultClientFactory)({
    endpoint,
    token,
    fetchImpl: dependencies.fetch || globalThis.fetch,
  });
  try {
    return await work(client, { endpoint, authenticationHeaderSent: Boolean(token) });
  } finally {
    if (!injected && typeof client?.close === 'function') await client.close();
  }
}

function asRows(value) {
  const pending = [value];
  const rows = [];
  while (pending.length) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) pending.push(current[index]);
    } else if (isRecord(current) && Array.isArray(current.tools)) {
      pending.push(current.tools);
    } else if (isRecord(current)) {
      rows.push(current);
      if (rows.length > MAX_SAM_DISCOVERY_ROWS) {
        throw new SamClientError(
          'sam_discovery_rows_too_many',
          `SAM discovery exceeded the ${MAX_SAM_DISCOVERY_ROWS}-row safety limit.`,
          { status: 502 },
        );
      }
    }
  }
  return rows;
}

function redactEndpoint(endpoint, includePrivate = false) {
  const requestUrl = new URL(endpoint.href);
  requestUrl.hash = '';
  const output = {
    endpoint_ref: hashRef({ request_url: requestUrl.href }),
    endpoint_loopback: isLoopback(endpoint.hostname),
  };
  if (includePrivate) output.private_endpoint_origin = endpoint.origin;
  return output;
}

function redactMeshInfo(value, includePrivate = false) {
  const info = isRecord(value) ? value : {};
  const peers = Array.isArray(info.connected_peers) ? info.connected_peers : [];
  const output = {
    connected_peer_count: peers.length,
    dht_size: Number.isFinite(Number(info.dht_size)) ? Number(info.dht_size) : null,
    router_peer_ref: info.router_peer_id ? hashRef({ router_peer_id: info.router_peer_id }) : null,
    local_api_socket_present: Boolean(info.local_api_socket),
  };
  if (includePrivate) output.private_mesh_info = info;
  return output;
}

/**
 * Inspect local mesh state and discover remote MCP tools. This path does not
 * call any remote provider tool.
 */
export async function discoverSamTools(options = {}, dependencies = {}) {
  return withClient(options, dependencies, async (client, connection) => {
    const meshInfo = await callTool(client, 'get_mesh_info', {});
    const services = await callTool(client, 'discover_remote_services', {
      type: 'mcp',
      ...(options.serviceName ? { name: String(options.serviceName) } : {}),
    });
    const tools = await callTool(client, 'find_remote_tools', {
      ...(options.peerId ? { peer_id: String(options.peerId) } : {}),
      ...(options.serviceName ? { service_name: String(options.serviceName) } : {}),
      ...(options.toolName ? { tool_name: String(options.toolName) } : {}),
    });
    const rows = asRows(tools);
    return {
      schema: 'agoragentic.interchange.sam-discovery.v1',
      captured_at: dependencies.now?.() || new Date().toISOString(),
      ...redactEndpoint(connection.endpoint, options.includePrivateTopology === true),
      authentication_header_sent: connection.authenticationHeaderSent,
      mesh: redactMeshInfo(meshInfo, options.includePrivateTopology === true),
      service_count: asRows(services).length,
      tool_count: rows.filter((row) => !row.error).length,
      tools: options.includePrivateTopology
        ? rows
        : rows.map((row) => ({
            peer_ref: row.peer_id ? hashRef({ peer_id: row.peer_id }) : null,
            tool_ref: row.tool_name ? hashRef({ tool_name: row.tool_name }) : null,
            description: String(row.description || ''),
            observed_label_keys: isRecord(row.labels) ? Object.keys(row.labels).sort() : [],
            error: row.error || null,
          })),
      safety: {
        provider_invoked: false,
        funds_moved: false,
        marketplace_publication: false,
        raw_topology_public: false,
      },
    };
  });
}

/**
 * Find and describe one exact SAM tool, then normalize the observation into an
 * ineligible Interchange import packet. No call_remote_tool request is made.
 */
export async function captureSamTool({ peerId, toolName }, options = {}, dependencies = {}) {
  const peer = String(peerId || '').trim();
  const tool = String(toolName || '').trim();
  if (!peer) throw new SamClientError('sam_peer_id_required', 'peerId is required.', { status: 400 });
  if (!tool) throw new SamClientError('sam_tool_name_required', 'toolName is required.', { status: 400 });
  if (peer.length > 256 || /\s/.test(peer)) {
    throw new SamClientError('sam_peer_id_invalid', 'peerId is malformed or too long.', { status: 400 });
  }
  let parsedTool;
  try {
    parsedTool = parseSamToolName(tool);
  } catch (cause) {
    throw new SamClientError('sam_tool_name_invalid', 'toolName must use SAM\'s mcp://service/tool namespace.', {
      status: 400,
      cause,
    });
  }

  return withClient(options, dependencies, async (client, connection) => {
    const matches = asRows(await callTool(client, 'find_remote_tools', {
      peer_id: peer,
      tool_name: parsedTool.bareToolName,
    }))
      .filter((row) => row.peer_id === peer && row.tool_name === tool && !row.error);
    if (matches.length !== 1) {
      throw new SamClientError(
        'sam_exact_tool_match_required',
        `Expected exactly one matching tool from find_remote_tools; found ${matches.length}.`,
        { status: 409 },
      );
    }
    const description = await callTool(client, 'describe_remote_tool', {
      peer_id: peer,
      tool_name: tool,
    });
    const capturedAt = dependencies.now?.() || new Date().toISOString();
    const packet = normalizeSamTool({
      discovery: matches[0],
      description,
      observedAt: capturedAt,
      includePrivateTarget: options.includePrivateTarget === true,
    });
    return {
      schema: 'agoragentic.interchange.sam-live-capture.v1',
      captured_at: capturedAt,
      ...redactEndpoint(connection.endpoint, options.includePrivateTarget === true),
      authentication_header_sent: connection.authenticationHeaderSent,
      packet,
      capture_evidence: {
        sam_endpoint_called: true,
        sam_control_calls_made: ['find_remote_tools', 'describe_remote_tool'],
        find_remote_tools_succeeded: true,
        describe_remote_tool_succeeded: true,
        exact_peer_and_tool_match: true,
        external_provider_called: false,
        provider_invoked: false,
        call_remote_tool_used: false,
        funds_moved: false,
        settlement_final: false,
      },
    };
  });
}

function parseArgs(argv) {
  const args = { command: argv[0] || '', allowRemote: false, includePrivateTopology: false };
  for (let i = 1; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--peer') args.peerId = argv[++i];
    else if (value === '--tool') args.toolName = argv[++i];
    else if (value === '--service') args.serviceName = argv[++i];
    else if (value === '--endpoint') args.endpoint = argv[++i];
    else if (value === '--token-path') args.tokenPath = argv[++i];
    else if (value === '--allow-remote') args.allowRemote = true;
    else if (value === '--include-private-topology') args.includePrivateTopology = true;
    else if (value === '--include-private-target') args.includePrivateTarget = true;
    else if (value === '--help' || value === '-h') args.help = true;
    else throw new SamClientError('unknown_argument', `Unknown argument: ${value}`, { status: 400 });
  }
  return args;
}

function help() {
  return `Usage:
  node interchange/sam/client.mjs discover [--service NAME] [--peer PEER_ID]
  node interchange/sam/client.mjs capture --peer PEER_ID --tool mcp://service/tool

Options:
  --endpoint URL              Defaults to http://127.0.0.1:8080/mcp.
  --token-path PATH           Read the local SAM API token without placing it on the command line.
  --allow-remote              Permit an operator-approved non-loopback HTTPS endpoint.
  --include-private-topology  Include raw discovery rows in local output only.
  --include-private-target    Include raw peer/tool target in local capture output only.

This command never calls call_remote_tool and never moves funds.`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    console.log(help());
    return;
  }
  let result;
  if (args.command === 'discover') result = await discoverSamTools(args);
  else if (args.command === 'capture') result = await captureSamTool(args, args);
  else throw new SamClientError('unknown_command', `Unknown command: ${args.command}`, { status: 400 });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    const payload = error instanceof SamClientError
      ? { error: { code: error.code, message: error.message, retryable: error.retryable } }
      : { error: { code: 'unexpected_error', message: error instanceof Error ? error.message : String(error) } };
    console.error(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
  });
}
