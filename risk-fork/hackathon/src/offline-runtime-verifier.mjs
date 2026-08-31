import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { runWithRiskForkDemoLoopback } from '../scripts/network-scope.mjs';
import { createDemoEngine, verifyDemoEnvelope } from './demo-engine.mjs';
import { createFlightRecorderServer, writeRecorderRecord } from './flight-recorder.mjs';
import {
  RISK_FORK_DEMO_BANNER,
  RISK_FORK_DEMO_LIMITS,
  assertDemoTruth,
  inspectOwnedDemoTree,
  openOwnedDemoRoot,
} from './security.mjs';

const REPRESENTATIVE_SCENARIOS = Object.freeze([
  'low-read-only',
  'high-filesystem-write',
  'e2b-malicious-mcp-containment',
  'irreversible-deployment-proposal',
  'deny-owner-policy',
  'cleanup-unknown',
  'malformed-lifecycle-receipt',
  'attack-secret',
]);

function sha256Ref(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function samePath(left, right) {
  const a = path.normalize(path.resolve(left));
  const b = path.normalize(path.resolve(right));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function requestLocalRecorder({ server, pathname, token = null }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.port,
      path: pathname,
      method: 'GET',
      headers: {
        ...(token ? { authorization: `Bearer ${token}`, origin: server.origin } : {}),
      },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) {
          response.destroy(new Error('Recorder verification response exceeded 4 MiB'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

function assertRepresentativeResults(results) {
  const byId = new Map(results.map((result) => [result.scenario.id, result]));
  for (const result of results) {
    assertDemoTruth(result);
    verifyDemoEnvelope(result.demo_receipt);
  }
  if (byId.get('low-read-only')?.local_adapter_calls !== 0) {
    throw new Error('LOW representative unexpectedly called the local adapter');
  }
  const high = byId.get('high-filesystem-write');
  if (high?.decision?.level !== 'HIGH'
    || high.final_state !== 'prepared_not_committed'
    || high.core_receipt_verified !== true
    || high.cleanup?.status !== 'verified') {
    throw new Error('HIGH representative did not produce verified prepare-only evidence');
  }
  const fakeE2B = byId.get('e2b-malicious-mcp-containment');
  if (fakeE2B?.execution_mode !== 'fake_e2b_protocol_execution'
    || fakeE2B.provider_calls !== 0
    || fakeE2B.provider_evidence?.allocation_count !== 1
    || fakeE2B.provider_evidence?.retry_count !== 0
    || fakeE2B.provider_evidence?.sandbox_running !== false
    || fakeE2B.parent_state_unchanged !== true
    || fakeE2B.attack_attempts?.length !== 8
    || fakeE2B.cleanup?.status !== 'verified') {
    throw new Error('Fake E2B representative did not prove the offline containment contract');
  }
  const irreversible = byId.get('irreversible-deployment-proposal');
  if (irreversible?.execution_mode !== 'prepare_only'
    || irreversible.final_state !== 'prepared_not_committed') {
    throw new Error('IRREVERSIBLE representative was not prepare-only');
  }
  const denied = byId.get('deny-owner-policy');
  if (denied?.final_state !== 'denied' || denied.local_adapter_calls !== 0) {
    throw new Error('DENY representative did not stop before local adapter execution');
  }
  for (const id of ['cleanup-unknown', 'malformed-lifecycle-receipt', 'attack-secret']) {
    const result = byId.get(id);
    if (result?.final_state !== 'blocked' || result.exit_code === 0) {
      throw new Error(`${id} representative did not fail closed`);
    }
  }
  return high;
}

function hasExactDemoLimits(value) {
  if (!value || typeof value !== 'object') return false;
  const expected = Object.entries(RISK_FORK_DEMO_LIMITS);
  return Object.keys(value).length === expected.length
    && expected.every(([key, limit]) => value[key] === limit);
}

async function verifyRecorder(highResult, rootHandle) {
  return runWithRiskForkDemoLoopback(async () => {
    await writeRecorderRecord(rootHandle, highResult);
    const server = await createFlightRecorderServer({ records: [highResult] });
    try {
      const page = await requestLocalRecorder({ server, pathname: '/' });
      if (page.status !== 200
        || !page.body.includes('REPLAY')
        || !page.body.includes(RISK_FORK_DEMO_BANNER)
        || page.body.includes(server.token)
        || !String(page.headers['content-security-policy'] ?? '').includes("default-src 'none'")) {
        throw new Error('Flight Recorder page failed its loopback/CSP/token smoke contract');
      }
      const api = await requestLocalRecorder({
        server,
        pathname: '/api/records',
        token: server.token,
      });
      const payload = JSON.parse(api.body);
      const replay = payload.records?.[0];
      if (api.status !== 200
        || payload.mode !== 'REPLAY'
        || replay?.receipt_hash_verified !== true
        || replay?.receipt_binding_verified !== true
        || replay?.decision?.classifier_version !== 'v1'
        || !hasExactDemoLimits(replay?.limits)
        || replay?.tainted_output_evidence?.status !== 'sanitized_hash_only'
        || replay?.tainted_output_evidence?.sanitized !== true
        || replay?.tainted_output_evidence?.raw_output_included !== false
        || replay?.tainted_output_evidence?.reference_bytes
          > replay?.tainted_output_evidence?.max_reference_bytes
        || replay?.tainted_output_evidence?.hash_bytes
          !== replay?.tainted_output_evidence?.max_hash_bytes
        || api.body.includes(server.token)) {
        throw new Error('Flight Recorder record replay failed its sanitized receipt smoke contract');
      }
      return {
        mode: 'REPLAY',
        loopback_transport_used: true,
        external_network_used: false,
        token_redacted: true,
        csp_verified: true,
        receipt_visible: true,
        receipt_hash_verified_visible: true,
        receipt_binding_verified_visible: true,
        classifier_version_visible: true,
        all_demo_limits_visible: true,
        bounded_tainted_output_evidence_visible: true,
      };
    } finally {
      await server.close();
    }
  });
}

async function removeVerifiedTemporaryParent(parent, ownedRoot) {
  const parentReal = await realpath(parent);
  const expectedParent = path.resolve(os.tmpdir());
  if (!samePath(path.dirname(parentReal), expectedParent)) {
    throw new Error('Temporary verification parent is outside the operating-system temp root');
  }
  const entries = await readdir(parentReal);
  if (entries.length !== 1 || entries[0] !== path.basename(ownedRoot)) {
    throw new Error('Temporary verification parent contains an unexpected entry');
  }
  const rootHandle = await openOwnedDemoRoot(ownedRoot);
  const inventory = await inspectOwnedDemoTree(rootHandle, { maxFiles: 10, maxBytes: 64 * 1024 });
  if (inventory.entries.length !== 0) {
    throw new Error('Temporary owned root still contains demo artifacts after cleanup');
  }
  await rm(parentReal, { recursive: true, force: false, maxRetries: 0 });
  try {
    await lstat(parentReal);
    throw new Error('Temporary verification parent absence was not verified');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function runOfflineRuntimeVerification() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-offline-verification-'));
  const parentReal = await realpath(parent);
  const ownedRoot = path.join(parentReal, 'owned-root');
  const engine = createDemoEngine({ rootDirectory: ownedRoot });
  let cleanupVerified = false;
  try {
    const results = [];
    for (const scenario of REPRESENTATIVE_SCENARIOS) results.push(await engine.run(scenario));
    const highResult = assertRepresentativeResults(results);
    const rootHandle = await openOwnedDemoRoot(ownedRoot);
    const recorder = await verifyRecorder(highResult, rootHandle);
    const cleanup = await engine.cleanup();
    assertDemoTruth(cleanup);
    cleanupVerified = cleanup.cleanup?.status === 'verified';
    if (!cleanupVerified) throw new Error('Representative runtime cleanup was not verified');
    await removeVerifiedTemporaryParent(parentReal, ownedRoot);
    return Object.freeze({
      schema: 'agoragentic.risk-fork.offline-runtime-verification.v1',
      banner: RISK_FORK_DEMO_BANNER,
      demo_only: true,
      local_protocol_simulator: true,
      production_ready: false,
      live_traffic_protected: false,
      authority_granted: false,
      provider_calls: 0,
      network_used: false,
      credentials_used: false,
      clean_commit_performed: false,
      verified: true,
      temporary_root_ref: sha256Ref(parentReal),
      absolute_path_redacted: true,
      representative_scenarios: [...REPRESENTATIVE_SCENARIOS],
      results: results.map((result) => ({
        scenario_id: result.scenario.id,
        risk_level: result.decision.level,
        final_state: result.final_state,
        exit_code: result.exit_code,
        receipt_verified: verifyDemoEnvelope(result.demo_receipt),
        cleanup_status: result.cleanup.status,
      })),
      recorder,
      cleanup: { requested: true, absence: 'verified', status: 'verified' },
    });
  } catch (error) {
    if (!cleanupVerified) {
      try {
        const cleanup = await engine.cleanup();
        cleanupVerified = cleanup.cleanup?.status === 'verified';
      } catch {
        cleanupVerified = false;
      }
    }
    if (cleanupVerified) {
      await removeVerifiedTemporaryParent(parentReal, ownedRoot).catch(() => {});
    }
    throw error;
  }
}

export { REPRESENTATIVE_SCENARIOS };
