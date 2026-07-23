import { promises as fs } from 'node:fs';
import path from 'node:path';
import { authorityBoundary, sanitizeForPublicEvidence, stableHash, stableId } from './events.mjs';
import { appendRunEvent, harnessDir, relativeArtifactPath } from './state.mjs';

export const RUNTIME_PROBE_SCHEMA = 'agoragentic.harness.runtime-probe.v1';

const PROBE_PATHS = Object.freeze([
  '/health',
  '/.well-known/agent-card.json',
  '/tools',
  '/openapi.json',
  '/schema/agoragentic-rust-framework.json',
]);

const UNSAFE_TOOL_PATTERN = /\b(wallet|x402|settle|settlement|marketplace[_ -]?publish|publish[_ -]?listing|mutate[_ -]?trust|trust[_ -]?mutation|ranking|provider[_ -]?dispatch|process[_ -]?control|shell|exec|spawn|global[_ -]?execute|global[_ -]?invoke|private[_ -]?ecf|full[_ -]?ecf|owner[_ -]?approval[_ -]?bypass|bypass[_ -]?approval)\b/i;

export async function probeRuntime({
  dir = process.cwd(),
  url,
  contract = 'generic-local-http',
  runState = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2500,
} = {}) {
  if (!url) throw new Error('runtime probe requires --url');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable for runtime probe');
  const baseUrl = validateLoopbackRuntimeUrl(url);
  const createdAt = new Date().toISOString();
  const probeId = stableId('probe', `${baseUrl.href}:${contract}:${createdAt}`);
  const endpoints = [];
  const unsafeToolSpecs = [];
  const endpointPolicyBlocks = [];

  if (runState) {
    await appendRunEvent(dir, runState, {
      type: 'before_agent',
      severity: 'info',
      summary: 'Runtime metadata probe started.',
      data: { url: baseUrl.href, contract, method: 'GET', paths: PROBE_PATHS },
    });
  }

  for (const probePath of PROBE_PATHS) {
    const endpoint = new URL(probePath, baseUrl);
    const result = await fetchJson(endpoint, { fetchImpl, timeoutMs });
    const sanitizedBody = sanitizeForPublicEvidence(result.body);
    const record = {
      path: probePath,
      method: 'GET',
      ok: result.ok,
      http_status: result.http_status,
      content_type: result.content_type,
      redirect_blocked: Boolean(result.redirect_blocked),
      body_hash: result.body === null ? null : stableHash(sanitizedBody),
      summary: summarizeEndpointBody(probePath, sanitizedBody),
      body: sanitizedBody,
    };
    if (result.redirect_blocked) {
      endpointPolicyBlocks.push({
        path: probePath,
        reason: 'redirect_blocked',
        http_status: result.http_status,
      });
    }
    if (probePath === '/tools' && result.ok) {
      const toolValidation = validatePublicSafeTools(sanitizedBody);
      record.tools_valid = toolValidation.ok;
      record.tools = toolValidation.tools;
      record.rejected_tools = toolValidation.rejected_tools;
      unsafeToolSpecs.push(...toolValidation.rejected_tools);
    }
    endpoints.push(record);
  }

  const blocked = unsafeToolSpecs.length > 0 || endpointPolicyBlocks.length > 0;
  const artifact = {
    schema: RUNTIME_PROBE_SCHEMA,
    probe_id: probeId,
    created_at: createdAt,
    mode: 'local_no_spend_runtime_metadata_probe',
    contract,
    target: {
      url: baseUrl.href,
      loopback_only: true,
    },
    status: blocked ? 'blocked' : 'passed',
    method_policy: {
      get_only: true,
      invoke_attempted: false,
      execute_attempted: false,
      shell_attempted: false,
      paid_call_attempted: false,
    },
    endpoints,
    unsafe_tool_specs: unsafeToolSpecs,
    endpoint_policy_blocks: endpointPolicyBlocks,
    authority_boundary: authorityBoundary(),
  };

  const outputPath = await writeRuntimeProbeArtifact(dir, artifact);
  if (runState) {
    runState.artifacts = {
      ...(runState.artifacts || {}),
      runtime_probe: relativeArtifactPath(dir, outputPath),
    };
    await appendRunEvent(dir, runState, {
      type: blocked ? 'run_blocked' : 'artifact_written',
      severity: blocked ? 'blocked' : 'info',
      summary: blocked ? 'Runtime probe blocked unsafe endpoint or tool metadata.' : 'Runtime probe artifact written.',
      data: {
        probe_id: probeId,
        path: relativeArtifactPath(dir, outputPath),
        unsafe_tool_specs: unsafeToolSpecs,
        endpoint_policy_blocks: endpointPolicyBlocks,
      },
    });
  }
  return { artifact, path: outputPath };
}

export function validateLoopbackRuntimeUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('runtime probe supports http(s) loopback URLs only');
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (!loopback) throw new Error('runtime probe rejects non-loopback URLs by default');
  parsed.pathname = parsed.pathname || '/';
  return parsed;
}

export function validatePublicSafeTools(payload) {
  const rawTools = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.tools)
      ? payload.tools
      : Array.isArray(payload?.data?.tools)
        ? payload.data.tools
        : [];
  const tools = [];
  const rejected = [];
  for (const [index, raw] of rawTools.entries()) {
    const safe = sanitizeToolSpec(raw);
    const serialized = JSON.stringify(raw || {});
    if (UNSAFE_TOOL_PATTERN.test(serialized)) {
      rejected.push({
        index,
        name: safe.name || null,
        reason: 'unsafe_authority_claim',
      });
      continue;
    }
    tools.push(safe);
  }
  return {
    ok: rejected.length === 0,
    tools,
    rejected_tools: rejected,
  };
}

async function fetchJson(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const contentType = response.headers.get('content-type') || '';
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') || '';
      return {
        ok: false,
        http_status: response.status,
        content_type: contentType,
        redirect_blocked: true,
        body: {
          error: 'redirect_blocked',
          location_present: Boolean(location),
          location_hash: location ? stableHash(location) : null,
        },
      };
    }
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { text_preview: text.slice(0, 240) };
      }
    }
    return {
      ok: response.ok,
      http_status: response.status,
      content_type: contentType,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      http_status: null,
      content_type: null,
      body: { error: error.name === 'AbortError' ? 'timeout' : error.message },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function writeRuntimeProbeArtifact(dir, artifact) {
  const root = path.join(harnessDir(dir), 'runtime-probes');
  await fs.mkdir(root, { recursive: true });
  const filePath = path.join(root, `${artifact.probe_id}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return filePath;
}

function sanitizeToolSpec(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const safe = {};
  for (const key of ['name', 'id', 'description', 'input_schema', 'output_schema', 'schema', 'side_effects']) {
    if (Object.hasOwn(value, key)) safe[key] = sanitizeForPublicEvidence(value[key]);
  }
  if (!safe.name && safe.id) safe.name = safe.id;
  safe.public_safe = true;
  return safe;
}

function summarizeEndpointBody(probePath, body) {
  if (!body || typeof body !== 'object') return { kind: 'empty' };
  if (probePath === '/health') return { kind: 'health', status: body.status || body.ok || null };
  if (probePath === '/.well-known/agent-card.json') return { kind: 'agent_card', name: body.name || body.agent?.name || null };
  if (probePath === '/tools') {
    const count = Array.isArray(body) ? body.length : Array.isArray(body.tools) ? body.tools.length : 0;
    return { kind: 'tools', count };
  }
  if (probePath === '/openapi.json') return { kind: 'openapi', title: body.info?.title || null, version: body.info?.version || null };
  return { kind: 'schema', schema: body.$schema || null, title: body.title || null };
}
