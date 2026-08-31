#!/usr/bin/env node

import '../scripts/network-guard.mjs';

import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256Ref } from '../../src/canonical.mjs';
import { generateClientConfiguration, writeClientConfiguration } from '../src/config-generator.mjs';
import {
  createFlightRecorderServer,
  loadRecorderRecords,
  writeRecorderRecord,
} from '../src/flight-recorder.mjs';
import { serveStdioMcp } from '../src/mcp-server.mjs';
import { SCENARIO_IDS, listScenarios } from '../src/scenarios.mjs';
import {
  RISK_FORK_DEMO_BANNER,
  assertDemoTruth,
  createDemoTruth,
  initializeOwnedDemoRoot,
  openOwnedDemoRoot,
  sanitizeDemoError,
} from '../src/security.mjs';
import {
  assertDemoResultReceiptBinding,
  createDemoEngine,
  evaluateDemoNodeRuntime,
  getDefaultDemoRoot,
} from '../src/demo-engine.mjs';
import { verifyOfflineKit } from '../src/offline-kit.mjs';
import { runOfflineRuntimeVerification } from '../src/offline-runtime-verifier.mjs';

const entrypoint = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(entrypoint), '..');
const kitRoot = path.resolve(packageRoot, '..', '..');
const DEMO_TRUTH_KEYS = Object.freeze([
  'banner',
  'demo_only',
  'local_protocol_simulator',
  'production_ready',
  'live_traffic_protected',
  'authority_granted',
  'provider_calls',
  'network_used',
  'credentials_used',
  'clean_commit_performed',
]);

function baseResult(schema, value = {}) {
  if (value && typeof value === 'object' && DEMO_TRUTH_KEYS.some((key) => Object.hasOwn(value, key))) {
    assertDemoTruth(value);
  }
  const payload = structuredClone(value);
  for (const key of [...DEMO_TRUTH_KEYS, 'schema']) delete payload[key];
  const result = createDemoTruth({ schema, ...payload });
  assertDemoTruth(result);
  return result;
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function exactOption(args, name, allowedValues) {
  if (args.length !== 2 || args[0] !== name || !allowedValues.includes(args[1])) {
    throw new TypeError(`Expected ${name} followed by one allowed value`);
  }
  return args[1];
}

function configArguments(args) {
  const yesIndex = args.indexOf('--yes');
  const normalized = yesIndex === -1 ? [...args] : args.filter((_, index) => index !== yesIndex);
  if (yesIndex !== -1 && (yesIndex !== args.length - 1 || args.filter((item) => item === '--yes').length !== 1)) {
    throw new TypeError('--yes may appear exactly once at the end');
  }
  return { client: exactOption(normalized, '--client', ['generic', 'codex', 'claude', 'cursor']), yes: yesIndex !== -1 };
}

async function doctor(engine) {
  const node = evaluateDemoNodeRuntime();
  const status = await engine.status();
  let entrypointVerified = true;
  try {
    await access(entrypoint);
  } catch {
    entrypointVerified = false;
  }
  let rootState = 'not_initialized';
  let markerHash = null;
  try {
    await access(getDefaultDemoRoot());
    const handle = await openOwnedDemoRoot(getDefaultDemoRoot());
    rootState = 'verified_owned_root';
    markerHash = handle.marker_hash;
  } catch (error) {
    if (error?.code !== 'ENOENT') rootState = 'invalid_or_unowned_root';
  }
  const ready = node.supported && entrypointVerified && rootState !== 'invalid_or_unowned_root';
  return baseResult('agoragentic.risk-fork.demo-doctor.v1', {
    status: ready ? 'ready_for_local_demo' : 'blocked',
    node,
    entrypoint: {
      mode: 'pinned_local_node_entrypoint',
      ref: sha256Ref(entrypoint),
      absolute_path_redacted: true,
      verified_present: entrypointVerified,
    },
    owned_root: {
      ...status.owned_root,
      state: rootState,
      marker_hash: markerHash,
    },
    writes_performed: false,
    isolation_claim: 'none_local_protocol_simulator_only',
    exit_code: ready ? 0 : 2,
  });
}

async function persistResult(result) {
  const handle = await openOwnedDemoRoot(getDefaultDemoRoot());
  return writeRecorderRecord(handle, result);
}

async function runScenario(engine, scenario) {
  let interruptedBy = null;
  let abortPromise = null;
  let abortResult = null;
  const interrupt = (signal) => {
    interruptedBy ??= signal;
    abortPromise ??= engine.abort();
  };
  const onSigint = () => interrupt('SIGINT');
  const onSigterm = () => interrupt('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  let result;
  try {
    result = await engine.run(scenario);
    if (abortPromise) abortResult = await abortPromise;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
  const effective = interruptedBy
    ? {
        ...result,
        interruption: {
          signal: interruptedBy,
          cleanup: structuredClone(abortResult?.cleanup ?? {
            requested: false,
            absence: 'unknown',
            status: 'unknown',
          }),
          owned_run_cleanup: structuredClone(result.owned_run_cleanup),
        },
      }
    : result;
  assertDemoResultReceiptBinding(effective);
  let recorder;
  try {
    recorder = await persistResult(effective);
  } catch (error) {
    const output = baseResult('agoragentic.risk-fork.demo-run-output.v1', {
      ...effective,
      recorder: { status: 'failed', error: sanitizeDemoError(error) },
      delivery_status: 'recorder_failed_core_outcome_preserved',
    });
    assertDemoResultReceiptBinding(output);
    return output;
  }
  const output = baseResult('agoragentic.risk-fork.demo-run-output.v1', {
    ...effective,
    recorder: { status: 'verified_local_record', ...recorder },
  });
  assertDemoResultReceiptBinding(output);
  return output;
}

async function serveMcp(engine) {
  let abortPromise = null;
  const close = () => {
    abortPromise ??= engine.abort().finally(() => process.stdin.destroy());
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  try {
    await serveStdioMcp({ engine, onResult: persistResult });
    if (abortPromise) await abortPromise;
  } finally {
    process.off('SIGINT', close);
    process.off('SIGTERM', close);
  }
}

async function serveRecorder() {
  let records = [];
  try {
    records = await loadRecorderRecords(await openOwnedDemoRoot(getDefaultDemoRoot()));
  } catch (error) {
    if (!['ENOENT', 'RISK_FORK_DEMO_ROOT_NOT_INITIALIZED'].includes(error?.code)) throw error;
  }
  const server = await createFlightRecorderServer({ records });
  writeResult(baseResult('agoragentic.risk-fork.demo-flight-recorder.v1', {
    status: 'serving_local_replay',
    replay_mode: 'REPLAY',
    loopback_transport_used: true,
    network_used_scope: 'no_external_or_provider_network',
    launch_url: server.launch_url,
    records: records.length,
    exit_code: 0,
  }));
  await new Promise((resolve) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void server.close().finally(resolve);
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
  return null;
}

async function configure(args) {
  const { client, yes } = configArguments(args);
  const generated = generateClientConfiguration({ client, entrypoint: path.resolve(entrypoint) });
  if (!yes) {
    return baseResult('agoragentic.risk-fork.demo-config-result.v1', {
      mode: 'preview',
      writes_performed: false,
      configuration: generated,
      exit_code: 0,
    });
  }
  const root = await initializeOwnedDemoRoot(getDefaultDemoRoot());
  const written = await writeClientConfiguration(root, generated, { yes: true });
  return baseResult('agoragentic.risk-fork.demo-config-result.v1', {
    mode: 'written_to_owned_demo_root',
    writes_performed: true,
    configuration: written,
    exit_code: 0,
  });
}

async function verifyCurrentKit() {
  const node = evaluateDemoNodeRuntime();
  if (!node.supported) {
    return baseResult('agoragentic.risk-fork.demo-kit-verification.v1', {
      status: 'unsupported_node_runtime',
      verified: false,
      node,
      exit_code: 2,
    });
  }
  try {
    await access(path.join(kitRoot, 'MANIFEST.json'));
  } catch {
    return baseResult('agoragentic.risk-fork.demo-kit-verification.v1', {
      status: 'not_inside_offline_kit',
      verified: false,
      node,
      exit_code: 2,
    });
  }
  const result = await verifyOfflineKit({ kitDirectory: kitRoot });
  const runtime = await runOfflineRuntimeVerification();
  return baseResult('agoragentic.risk-fork.demo-kit-verification.v1', {
    ...result,
    node,
    runtime,
    exit_code: result.verified === true && runtime.verified === true ? 0 : 2,
  });
}

function usage() {
  return baseResult('agoragentic.risk-fork.demo-usage.v1', {
    status: 'usage',
    commands: [
      'doctor',
      'plan [--scenario <id>]',
      'run --scenario <id>',
      'serve',
      'config --client <generic|codex|claude|cursor> [--yes]',
      'cleanup',
      'verify-offline-kit',
    ],
    scenarios: listScenarios(),
    writes_performed: false,
    exit_code: 2,
  });
}

export async function runCli(argv = process.argv.slice(2)) {
  const command = argv[0];
  const args = argv.slice(1);
  const engine = createDemoEngine({ rootDirectory: getDefaultDemoRoot() });
  if (command === 'mcp') {
    if (args.length !== 0) throw new TypeError('mcp accepts no arguments');
    await serveMcp(engine);
    return null;
  }
  if (command === 'doctor' && args.length === 0) return doctor(engine);
  if (command === 'plan') {
    if (args.length === 0) {
      return baseResult('agoragentic.risk-fork.demo-plan-list.v1', {
        writes_performed: false,
        plans: await Promise.all(SCENARIO_IDS.map((scenario) => engine.plan(scenario))),
        exit_code: 0,
      });
    }
    return engine.plan(exactOption(args, '--scenario', SCENARIO_IDS));
  }
  if (command === 'run') return runScenario(engine, exactOption(args, '--scenario', SCENARIO_IDS));
  if (command === 'serve' && args.length === 0) return serveRecorder();
  if (command === 'config') return configure(args);
  if (command === 'cleanup' && args.length === 0) return engine.cleanup();
  if (command === 'verify-offline-kit' && args.length === 0) return verifyCurrentKit();
  if (['help', '--help', '-h'].includes(command) && args.length === 0) return usage();
  return usage();
}

async function main() {
  let result;
  try {
    result = await runCli();
  } catch (error) {
    result = baseResult('agoragentic.risk-fork.demo-cli-error.v1', {
      status: 'failed_closed',
      error: sanitizeDemoError(error),
      exit_code: 2,
    });
  }
  if (result !== null) {
    writeResult(result);
    process.exitCode = Number(result.exit_code ?? 0);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(entrypoint)) await main();
