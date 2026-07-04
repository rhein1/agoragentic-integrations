#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function parseJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function assertIncludes(haystack, needle, label) {
  assert.ok(haystack.includes(needle), `${label || 'file'} missing ${needle}`);
}

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    connection: 'close',
  });
  res.end(payload);
}

function startMockRustRuntime() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
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

    if (req.method === 'GET' && req.url === '/tools') {
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

    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
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

    if (req.method === 'GET' && req.url === '/openapi.json') {
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

    if (req.method === 'POST' && req.url === '/invoke') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
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
      });
      return undefined;
    }

    return jsonResponse(res, 404, { error: 'not_found' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function execJson(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\n${stderr || stdout || ''}`.trim();
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(new Error(`Expected JSON output from ${command}: ${stdout || stderr}`));
      }
    });
  });
}

function runNodeExample(baseUrl) {
  return execJson(process.execPath, ['rust-framework/typescript-call-rust-agent.mjs'], {
    cwd: root,
    env: { ...process.env, AGORAGENTIC_RUST_AGENT_URL: baseUrl },
    encoding: 'utf8',
    timeout: 15000,
  });
}

function runPythonCompile() {
  execFileSync(
    'python',
    [
      '-c',
      "import ast, pathlib; ast.parse(pathlib.Path('rust-framework/python_call_rust_agent.py').read_text(encoding='utf-8')); print('python syntax ok')",
    ],
    {
      cwd: root,
      stdio: 'pipe',
      timeout: 15000,
    }
  );
}

function runPythonExample(baseUrl) {
  return execJson('python', ['rust-framework/python_call_rust_agent.py'], {
    cwd: root,
    env: { ...process.env, AGORAGENTIC_RUST_AGENT_URL: baseUrl },
    encoding: 'utf8',
    timeout: 15000,
  });
}

function assertExampleOutput(output, label) {
  assert.equal(output.runtime.framework, 'agoragentic-rust', `${label} framework`);
  assert.equal(output.runtime.transport, 'http-json', `${label} transport`);
  assert.equal(output.runtime.harness_compatible, true, `${label} harness flag`);
  assert.equal(output.agent_card.name, 'public-sync-rust-agent', `${label} agent card name`);
  assert.equal(output.agent_card.local_only, true, `${label} agent card local-only flag`);
  assert.equal(output.agent_card.skill_count, 1, `${label} agent card skills`);
  assert.ok(output.openapi_paths.includes('/invoke'), `${label} openapi includes /invoke`);
  assert.ok(
    output.openapi_paths.includes('/.well-known/agent-card.json'),
    `${label} openapi includes agent card`
  );
  assert.ok(output.openapi_paths.includes('/openapi.json'), `${label} openapi includes /openapi.json`);
  assert.equal(output.typed_invoke.status, 'completed', `${label} typed invoke`);
  assert.equal(output.raw_invoke.status, 'completed', `${label} raw invoke`);
  assert.deepEqual(output.authority_boundary, {
    hosted_router_execute_changed: false,
    direct_invoke_changed: false,
    wallet_spend_enabled: false,
    x402_settlement_enabled: false,
    marketplace_publication_enabled: false,
    trust_mutation_enabled: false,
    native_bindings_required: false,
  });
}

async function main() {
  const readme = read('rust-framework/README.md');
  assertIncludes(readme, 'AGORAGENTIC_RUST_AGENT_URL', 'rust README');
  assertIncludes(readme, '/.well-known/agent-card.json', 'rust README');
  assertIncludes(readme, 'POST /api/execute', 'rust README');
  assertIncludes(readme, 'PyO3, N-API, WASM', 'rust README');
  assertIncludes(readme, 'does not publish Rust crates', 'rust README');

  const typescriptExample = read('rust-framework/typescript-call-rust-agent.ts');
  assertIncludes(typescriptExample, 'interface RustAgentCardResponse', 'TypeScript example');
  assertIncludes(typescriptExample, 'interface RustInvocationRequest', 'TypeScript example');
  assertIncludes(typescriptExample, "postJson<RustInvocationResponse>('/invoke'", 'TypeScript example');
  assertIncludes(typescriptExample, 'wallet_spend_enabled: false', 'TypeScript example');

  const rootReadme = read('README.md');
  assertIncludes(rootReadme, 'Agoragentic Rust Framework HTTP Runtime', 'root README');

  const llms = read('llms.txt');
  assertIncludes(llms, 'Rust Framework HTTP runtime examples', 'llms.txt');

  const skill = read('SKILL.md');
  assertIncludes(skill, 'Agoragentic Rust Framework HTTP examples', 'SKILL.md');

  const manifest = parseJson('integrations.json');
  // integrations.json.updated_at is intentionally bumped over time and is not part of
  // the Rust-framework public-sync contract, so we validate its shape (ISO date) rather
  // than freezing a literal value that would re-drift on every unrelated manifest edit.
  assert.match(manifest.updated_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(
    manifest.integrations.some(
      (item) =>
        item.id === 'agoragentic-rust-framework' &&
        item.language === 'rust' &&
        item.path === 'rust-framework/README.md'
    ),
    'integrations.json missing rust framework integration'
  );
  assert.equal(manifest.discovery.rust_framework, 'rust-framework/README.md');
  assert.equal(manifest.discovery.rust_framework_typescript_example, 'rust-framework/typescript-call-rust-agent.ts');
  assert.equal(manifest.discovery.rust_framework_node_example, 'rust-framework/typescript-call-rust-agent.mjs');

  const schema = parseJson('integrations.schema.json');
  assert.ok(
    schema.$defs.integration.properties.language.enum.includes('rust'),
    'integrations schema must allow rust integrations'
  );

  const harness = parseJson('rust-framework/agent-os-harness.example.json');
  assert.equal(harness.schema, 'agoragentic.agent-os.harness.v1');
  assert.equal(harness.rust_framework_runtime.name, 'agoragentic-rust');
  assert.equal(harness.rust_framework_runtime.harness_compatible, true);
  assert.equal(harness.agent_os_preview_request.safety_policy.wallet_spend_enabled, false);
  assert.equal(harness.agent_os_preview_request.safety_policy.x402_settlement_enabled, false);
  assert.equal(harness.agent_os_preview_request.safety_policy.marketplace_publication_enabled, false);
  assert.equal(harness.agent_os_preview_request.safety_policy.trust_mutation_enabled, false);

  runPythonCompile();

  const { server, baseUrl } = await startMockRustRuntime();
  try {
    assertExampleOutput(await runNodeExample(baseUrl), 'node');
    assertExampleOutput(await runPythonExample(baseUrl), 'python');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('✅ Rust framework public sync verification passed');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
