#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDockerExample } from '../docker-example/runner.mjs';
import { runMcpClientConformance } from './mcp-client-conformance.mjs';
import { OFFLINE_KIT_BANNER, OFFLINE_KIT_TRUTH, verifyOfflineKit } from '../src/offline-kit.mjs';
import { runOfflineRuntimeVerification } from '../src/offline-runtime-verifier.mjs';
import { evaluateDemoNodeRuntime } from '../src/demo-engine.mjs';

await import('./network-guard.mjs');

const script = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(script), '..');
const kitRoot = path.resolve(packageRoot, '..', '..');
const entrypoint = path.join(packageRoot, 'bin', 'risk-fork-demo.mjs');

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--docker')) {
    throw new Error('INVALID_REVIEWER_SELF_TEST_ARGUMENT');
  }
  if (!evaluateDemoNodeRuntime().supported) throw new Error('UNSUPPORTED_NODE_RUNTIME');

  const kit = await verifyOfflineKit({ kitDirectory: kitRoot });
  if (kit.verified !== true) throw new Error('OFFLINE_KIT_UNVERIFIED');
  const runtime = await runOfflineRuntimeVerification();
  if (runtime.verified !== true || runtime.cleanup?.status !== 'verified') {
    throw new Error('OFFLINE_RUNTIME_UNVERIFIED');
  }
  const mcp = await runMcpClientConformance({ entrypoint });
  if (mcp.verified !== true || mcp.cleanup?.status !== 'verified') {
    throw new Error('MCP_CONFORMANCE_UNVERIFIED');
  }

  let docker = { status: 'not_requested', integrated_with_risk_fork: false };
  if (args[0] === '--docker') {
    const probe = await runDockerExample({ mode: 'probe' });
    if (probe.status !== 'verified_local_mcp_probe' || probe.cleanup !== 'verified_absent') {
      throw new Error('DOCKER_MCP_PROBE_UNVERIFIED');
    }
    docker = {
      status: probe.status,
      cleanup: probe.cleanup,
      integrated_with_risk_fork: false,
    };
  }

  process.stdout.write(`${JSON.stringify({
    schema: 'agoragentic.risk-fork.reviewer-self-test.v1',
    banner: OFFLINE_KIT_BANNER,
    ...OFFLINE_KIT_TRUTH,
    status: 'verified_local_reviewer_self_test',
    source_commit: kit.source_commit,
    offline_kit_verified: true,
    runtime_verified: true,
    mcp_conformance_verified: true,
    cleanup: 'verified',
    docker_probe: docker,
    external_agent_connected: false,
    integrated_container_protection: false,
  }, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    schema: 'agoragentic.risk-fork.reviewer-self-test.v1',
    ...OFFLINE_KIT_TRUTH,
    status: 'failed_closed',
    code: typeof error?.code === 'string' ? error.code : 'REVIEWER_SELF_TEST_FAILED',
    cleanup: 'unknown',
  })}\n`);
  process.exitCode = 2;
}
