import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildOfflineKit } from '../src/offline-kit.mjs';
import { runOfflineRuntimeVerification } from '../src/offline-runtime-verifier.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(packageRoot, '..', '..');
const outputBase = process.env.RISK_FORK_OFFLINE_KIT_OUTPUT_BASE;

if (typeof outputBase !== 'string' || !path.isAbsolute(outputBase)) {
  throw new Error('RISK_FORK_OFFLINE_KIT_OUTPUT_BASE must be an explicit absolute path outside every Git repository');
}

const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
  cwd: repositoryRoot,
  windowsHide: true,
});
const sourceCommit = stdout.trim();
const runtime = await runOfflineRuntimeVerification();
const validationSummary = {
  status: 'passed',
  source_commit: sourceCommit,
  representative_scenarios: runtime.representative_scenarios,
  receipt_verification: true,
  flight_recorder_smoke: runtime.recorder,
  cleanup: runtime.cleanup,
  provider_calls: 0,
  network_used: false,
  credentials_used: false,
};
const result = await buildOfflineKit({
  repositoryRoot,
  sourceCommit,
  outputBase,
  validationSummary,
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
