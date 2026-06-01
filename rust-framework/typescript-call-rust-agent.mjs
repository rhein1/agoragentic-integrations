#!/usr/bin/env node

import http from 'node:http';
import https from 'node:https';

const baseUrl = normalizeBaseUrl(
  process.env.AGORAGENTIC_RUST_AGENT_URL || 'http://127.0.0.1:8080'
);

function normalizeBaseUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(trimmed)) {
    throw new Error('AGORAGENTIC_RUST_AGENT_URL must be an http(s) URL');
  }
  return trimmed;
}

function requestJson(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = options.body || null;
    const headers = {
      'content-type': 'application/json',
      connection: 'close',
      ...(options.headers || {}),
    };
    if (payload) {
      headers['content-length'] = Buffer.byteLength(payload);
    }

    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      url,
      {
        method: options.method || 'GET',
        headers,
        timeout: 10000,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          let json;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (error) {
            reject(new Error(`${path} returned non-JSON response: ${text.slice(0, 120)}`));
            return;
          }
          if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
            reject(new Error(`${path} failed with HTTP ${res.statusCode}: ${JSON.stringify(json)}`));
            return;
          }
          resolve(json);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`${path} timed out`));
    });
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function postJson(path, body) {
  return requestJson(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function main() {
  const health = await requestJson('/health');
  const tools = await requestJson('/tools');
  const openapi = await requestJson('/openapi.json');

  const typedRequest = {
    request_id: 'req_public_ts_example',
    agent_id: health.agent_id || 'rust-agent',
    task: 'summarize',
    input: {
      text: 'Rust agents expose HTTP/JSON contracts for TypeScript and Python callers.',
    },
    trace: {
      trace_id: 'trace_public_ts_example',
    },
    limits: {
      timeout_ms: 30000,
      max_cost_usdc: 0,
    },
  };

  const typedInvoke = await postJson('/invoke', typedRequest);
  const rawInvoke = await postJson('/invoke', {
    text: 'Raw JSON payloads remain compatible with simple marketplace-style callers.',
  });

  const summary = {
    runtime: {
      framework: health.framework,
      framework_version: health.framework_version,
      transport: health.runtime?.transport,
      harness_compatible: health.runtime?.harness_compatible === true,
    },
    tools_count: Array.isArray(tools.tools) ? tools.tools.length : 0,
    openapi_paths: Object.keys(openapi.paths || {}).sort(),
    typed_invoke: {
      status: typedInvoke.status,
      request_id: typedInvoke.request_id,
      trace_id: typedInvoke.trace?.trace_id,
    },
    raw_invoke: {
      status: rawInvoke.status,
      request_id: rawInvoke.request_id,
    },
    authority_boundary: {
      hosted_router_execute_changed: false,
      direct_invoke_changed: false,
      wallet_spend_enabled: false,
      x402_settlement_enabled: false,
      marketplace_publication_enabled: false,
      trust_mutation_enabled: false,
      native_bindings_required: false,
    },
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
