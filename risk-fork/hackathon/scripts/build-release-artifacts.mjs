#!/usr/bin/env node

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildOfflineKit } from '../src/offline-kit.mjs';
import {
  REPRESENTATIVE_SCENARIOS,
  runOfflineRuntimeVerification,
} from '../src/offline-runtime-verifier.mjs';
import {
  finalizeReleaseArtifactDirectory,
  writeReleaseSidecars,
} from './release-artifacts.mjs';

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptRoot, '..', '..', '..');
const outputBase = process.env.RISK_FORK_RELEASE_OUTPUT_BASE;

if (typeof outputBase !== 'string' || !path.isAbsolute(outputBase)) {
  throw new Error('RISK_FORK_RELEASE_OUTPUT_BASE must be an explicit absolute path outside every Git repository');
}

for (const [name, expected] of [
  ['AGORAGENTIC_NO_SPEND', '1'],
  ['AGORAGENTIC_ALLOW_REAL_SPEND', '0'],
  ['AGORAGENTIC_ALLOW_NETWORK_CANARIES', '0'],
]) {
  if (process.env[name] !== expected) throw new Error(`${name} must be ${expected} for a release-candidate build`);
}

const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
  cwd: repositoryRoot,
  windowsHide: true,
});
const sourceCommit = stdout.trim();
if (process.env.RISK_FORK_RELEASE_SOURCE_SHA
  && process.env.RISK_FORK_RELEASE_SOURCE_SHA !== sourceCommit) {
  throw new Error('Checked-out HEAD does not match RISK_FORK_RELEASE_SOURCE_SHA');
}

// The local-reference adapter intentionally fails closed on Windows until an
// exact ACL proof is available. Build the artifact and record that runtime
// verification is not applicable on this platform; POSIX release builds still
// execute the complete offline runtime verifier below.
const runtime = process.platform === 'win32'
  ? {
      verified: false,
      provider_calls: 0,
      network_used: false,
      credentials_used: false,
      representative_scenarios: [],
      representative_scenarios_not_tested: [...REPRESENTATIVE_SCENARIOS],
      recorder: { status: 'unknown_not_tested' },
      cleanup: { requested: false, absence: 'not_applicable', status: 'not_applicable' },
      runtime_verification: {
        status: 'not_applicable',
        verified: false,
        reason: 'Windows local-reference ACL proof is unavailable',
      },
    }
  : await runOfflineRuntimeVerification();
const build = await buildOfflineKit({
  repositoryRoot,
  sourceCommit,
  outputBase,
  npmCacheDirectory: process.env.RISK_FORK_NPM_CACHE ?? null,
  validationSummary: {
    status: 'passed_release_candidate_build',
    source_commit: sourceCommit,
    representative_scenarios: runtime.representative_scenarios,
    receipt_verification: runtime.verified === true ? true : 'unknown_not_tested',
    flight_recorder_smoke: runtime.recorder,
    cleanup: runtime.cleanup,
    runtime_verification: runtime.runtime_verification ?? {
      status: 'verified',
      verified: true,
    },
    provider_calls: 0,
    network_used: false,
    credentials_used: false,
  },
});
const sidecars = await writeReleaseSidecars({ build });
const finalization = await finalizeReleaseArtifactDirectory({ build, outputBase });
process.stdout.write(`${JSON.stringify({ build, sidecars, finalization }, null, 2)}\n`);
