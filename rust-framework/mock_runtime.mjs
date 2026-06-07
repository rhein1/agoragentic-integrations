#!/usr/bin/env node
/**
 * Mock Agoragentic Rust Framework HTTP Runtime Server.
 * 
 * Provides mock implementations for health, discovery, tools list, OpenAPI schema,
 * Rust framework JSON schema, direct invocation, and A2A-compatible JSON-RPC invocation.
 */

import http from 'node:http';

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    connection: 'close',
  });
  res.end(payload);
}

export function createMockServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/health') {
      return jsonResponse(res, 200, {
        status: 'ok',
        framework: 'agoragentic-rust',
        framework_version: '0.1.0',
        agent_id: 'public-sync-rust-agent',
        runtime: {
          language: 'rust',
          transport: 'http-json',
          harness_compatible: true,
        },
      });
    }

    if (req.method === 'GET' && url.pathname === '/tools') {
      return jsonResponse(res, 200, {
        tools: [
          {
            name: 'summarize',
            description: 'Summarize public-safe text',
            input_schema: { type: 'object' },
            output_schema: { type: 'object' },
          },
        ],
      });
    }

    if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
      return jsonResponse(res, 200, {
        name: 'public-sync-rust-agent',
        version: '0.1.0',
        documentationUrl: 'https://agoragentic.com/openapi-agoragentic-rust-framework.yaml',
        supportedInterfaces: [
          { type: 'http-json', url: '/invoke' },
          { type: 'a2a-json-rpc', url: '/a2a/invoke' },
        ],
        skills: [
          {
            id: 'summarize',
            name: 'summarize',
            description: 'Summarize public-safe text',
            inputModes: ['application/json'],
            outputModes: ['application/json'],
          },
        ],
        extensions: {
          'agoragentic:rust_framework': {
            framework: 'agoragentic-rust',
            local_only: true,
            authority_boundary: {
              wallet_spend_enabled: false,
              x402_settlement_enabled: false,
              marketplace_publication_enabled: false,
              trust_state_mutation_enabled: false,
            },
          },
        },
      });
    }

    if (req.method === 'GET' && url.pathname === '/openapi.json') {
      return jsonResponse(res, 200, {
        openapi: '3.1.0',
        info: { title: 'Agoragentic Rust Framework Runtime', version: '0.1.0' },
        paths: {
          '/health': {},
          '/.well-known/agent-card.json': {},
          '/tools': {},
          '/openapi.json': {},
          '/invoke': {},
          '/a2a/invoke': {},
          '/schema/agoragentic-rust-framework.json': {},
        },
        'x-agoragentic': {
          framework: 'agoragentic-rust',
          transport: 'http-json',
          hosted_provisioning: false,
          wallet_spend: false,
          x402_settlement: false,
          marketplace_publication: false,
          trust_mutation: false,
        },
      });
    }

    if (req.method === 'GET' && url.pathname === '/schema/agoragentic-rust-framework.json') {
      return jsonResponse(res, 200, {
        $schema: 'http://json-schema.org/draft-07/schema#',
        title: 'AgoragenticRustFrameworkEnvelope',
        type: 'object',
        properties: {
          request_id: { type: 'string' },
          agent_id: { type: 'string' },
          task: { type: 'string' },
          input: { type: 'object' },
        },
        required: ['request_id', 'agent_id', 'task'],
      });
    }

    if (req.method === 'POST' && url.pathname === '/invoke') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        try {
          const body = raw ? JSON.parse(raw) : {};
          const requestId = body.request_id || 'req_mock_raw';
          return jsonResponse(res, 200, {
            request_id: requestId,
            agent_id: body.agent_id || 'public-sync-rust-agent',
            status: 'completed',
            output: {
              summary: String(body.input?.text || body.text || '').slice(0, 80),
            },
            trace: body.trace || { trace_id: 'trace_mock_raw' },
          });
        } catch (e) {
          return jsonResponse(res, 400, { error: 'invalid_json' });
        }
      });
      return undefined;
    }

    if (req.method === 'POST' && url.pathname === '/a2a/invoke') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        try {
          const body = raw ? JSON.parse(raw) : {};
          // Validate A2A JSON-RPC envelope
          if (body.jsonrpc !== '2.0' || !body.method || body.id === undefined) {
            return jsonResponse(res, 400, {
              jsonrpc: '2.0',
              error: { code: -32600, message: 'Invalid Request' },
              id: null,
            });
          }
          return jsonResponse(res, 200, {
            jsonrpc: '2.0',
            result: {
              status: 'completed',
              output: {
                summary: 'Processed via A2A-JSON-RPC',
              },
            },
            id: body.id,
          });
        } catch (e) {
          return jsonResponse(res, 400, {
            jsonrpc: '2.0',
            error: { code: -32700, message: 'Parse error' },
            id: null,
          });
        }
      });
      return undefined;
    }

    return jsonResponse(res, 404, { error: 'not_found' });
  });

  return server;
}

// Support running directly from command line
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('mock_runtime.mjs')) {
  const port = process.env.PORT || 8080;
  const server = createMockServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`Mock Rust Framework runtime running at http://127.0.0.1:${port}`);
  });
}
