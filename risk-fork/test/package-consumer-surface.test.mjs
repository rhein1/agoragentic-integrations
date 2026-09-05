import assert from 'node:assert/strict';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

test('a clean copied consumer can import and exercise the framework-neutral package subpath', async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@agoragentic/risk-fork');
  assert.equal(manifest.version, '0.1.0-alpha.1');
  assert.equal(manifest.private, false);
  assert.equal(manifest.publishConfig.tag, 'alpha');
  assert.equal(manifest.publishConfig.provenance, true);
  assert.equal(manifest.license, 'Apache-2.0');
  assert.equal(manifest.engines.node, '>=20');
  assert.equal(manifest.exports['./host-boundary'], './src/host-boundary.mjs');
  assert.equal(
    manifest.exports['./framework-tool-adapter'],
    './src/framework-tool-adapter.mjs',
  );
  assert.equal(
    manifest.exports['./frameworks/openai-agents'],
    './src/frameworks/openai-agents.mjs',
  );
  assert.equal(manifest.exports['./frameworks/langchain'], './src/frameworks/langchain.mjs');
  assert.equal(manifest.exports['./frameworks/langgraph'], './src/frameworks/langgraph.mjs');
  assert.match(
    await readFile(path.join(packageRoot, 'NOTICE'), 'utf8'),
    /Risk Fork[\s\S]*Copyright 2026 Agoragentic/,
  );

  const tempRoot = await mkdtemp(path.join(tmpdir(), 'risk-fork-clean-consumer-'));
  const installedRoot = path.join(
    tempRoot,
    'node_modules',
    '@agoragentic',
    'risk-fork',
  );
  try {
    await mkdir(installedRoot, { recursive: true });
    await cp(
      path.join(packageRoot, 'package.json'),
      path.join(installedRoot, 'package.json'),
    );
    await cp(
      path.join(packageRoot, 'src'),
      path.join(installedRoot, 'src'),
      { recursive: true },
    );

    const consumer = String.raw`
      import assert from 'node:assert/strict';
      import {
        RISK_FORK_HOST_BOUNDARY_SCHEMA,
        createRiskForkHostBoundary,
        createTrustedRiskDescriptor,
        createTrustedRiskDescriptorSource,
        isRiskForkHostBoundary,
      } from '@agoragentic/risk-fork/host-boundary';
      import {
        RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES,
        createRiskForkFrameworkToolAdapter,
      } from '@agoragentic/risk-fork/framework-tool-adapter';
      import { createOpenAIAgentsRiskForkTool }
        from '@agoragentic/risk-fork/frameworks/openai-agents';
      import { createLangChainRiskForkTool }
        from '@agoragentic/risk-fork/frameworks/langchain';
      import { createLangGraphRiskForkNode }
        from '@agoragentic/risk-fork/frameworks/langgraph';

      const source = createTrustedRiskDescriptorSource((request) => (
        createTrustedRiskDescriptor(request, {
          mcp_phase: 'tools/call',
          raw_method: null,
          mcp_server_ref: 'server:clean-consumer',
          mcp_server_origin: 'https://consumer.example.test',
          mcp_server_trust: 'reachable',
          mcp_server_attestation: null,
          tool_name: 'workspace_write',
          tool_annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
          },
          capabilities: {
            network_access: false,
            filesystem_read: false,
            filesystem_write: true,
            credential_access: false,
            wallet_or_payment: false,
            deployment: false,
            publication: false,
            communication: false,
            database_mutation: false,
            trust_or_reputation_mutation: false,
            external_side_effect: false,
            unknown_or_unclassified: false,
          },
          prompt_injection_indicators: [],
          owner_policy: {
            minimum_level: 'LOW',
            force_risk_fork: false,
            deny_irreversible: false,
            trusted_server_refs: [],
            trusted_attestor_refs: [],
            trusted_attestation_hashes: [],
            trust_registry_version: null,
            allowed_egress: [],
          },
        })
      ));
      const boundary = createRiskForkHostBoundary({
        controller: {
          async prepare(input) {
            assert.equal(input.risk_input.tool_name, 'workspace_write');
            return { mode: 'prepared_for_clean_commit', authority_granted: false };
          },
        },
        trusted_descriptor_source: source,
        clock: () => '2026-08-29T14:00:00.000Z',
      });
      const result = await boundary.preEffect({
        descriptor_ref: 'descriptor:clean-consumer',
        operation_input: {
          operation: { kind: 'bounded-file-work' },
          expected_commit_type: 'TYPED_RESULT',
        },
      });
      assert.equal(boundary.schema, RISK_FORK_HOST_BOUNDARY_SCHEMA);
      assert.equal(isRiskForkHostBoundary(boundary), true);
      assert.equal(boundary.controller, undefined);
      assert.equal(boundary.provider, undefined);
      assert.equal(result.authority_granted, false);
      assert.equal(result.provider_handle_exposed, false);
      const adapters = Object.fromEntries([
        ['openai-agents', 'openai_effect'],
        ['langchain', 'langchain_effect'],
        ['langgraph', 'langgraph_effect'],
      ].map(([framework, toolName]) => [framework, createRiskForkFrameworkToolAdapter({
        framework,
        tool_name: toolName,
        descriptor_ref: 'descriptor:' + toolName,
      })]));
      const openai = createOpenAIAgentsRiskForkTool({ enforcement: adapters['openai-agents'] });
      const langchain = createLangChainRiskForkTool({ enforcement: adapters.langchain });
      const langgraph = createLangGraphRiskForkNode({ enforcement: adapters.langgraph });
      assert.equal(openai.needsApproval, true);
      assert.equal(openai.status.default_on, false);
      assert.equal(langchain.status.live_traffic_protected, false);
      assert.equal(langgraph.status.trusted_executor_bound, false);
      await assert.rejects(
        openai.execute({ value: 'blocked' }),
        error => error.code === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.DISABLED,
      );
      await assert.rejects(
        langchain.handler({ value: 'blocked' }),
        error => error.code === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.DISABLED,
      );
      await assert.rejects(
        langgraph.node({ tool_input: { value: 'blocked' } }),
        error => error.code === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.DISABLED,
      );
      process.stdout.write('RISK_FORK_CLEAN_CONSUMER_OK');
    `;
    const run = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', consumer],
      {
        cwd: tempRoot,
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '' },
        timeout: 15_000,
      },
    );
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    assert.equal(run.stdout, 'RISK_FORK_CLEAN_CONSUMER_OK');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
