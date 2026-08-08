#!/usr/bin/env node
import { compileGstackArtifacts, GstackHarnessError, REQUIRED_STAGES } from './gstack-harness.mjs';

function usage() {
  return `Usage:
  node cli.mjs --project <dir> --plan <file> --review <file>
               --qa <file> --release <file> --out <new-dir>
               [--created-at <ISO timestamp>]

Reads four explicit local gstack workflow artifacts as untrusted data and emits
bounded Harness Core evidence under <new-dir>/.agoragentic. The bridge does not
run gstack, call a network or provider, deploy, publish, spend, or settle.
`;
}

function parseArgs(argv) {
  const values = {};
  const args = [...argv];
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--help' || flag === '-h') return { help: true };
    if (!flag.startsWith('--')) throw new GstackHarnessError('invalid_argument', `Unexpected argument: ${flag}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new GstackHarnessError('invalid_argument', `Missing value for ${flag}`);
    values[flag.slice(2)] = value;
  }
  const known = new Set(['project', 'plan', 'review', 'qa', 'release', 'out', 'created-at']);
  for (const key of Object.keys(values)) {
    if (!known.has(key)) throw new GstackHarnessError('invalid_argument', `Unknown option: --${key}`);
  }
  return values;
}

try {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    process.exitCode = 0;
  } else {
    const artifacts = Object.fromEntries(REQUIRED_STAGES.map(stage => [
      stage,
      parsed[stage === 'planning' ? 'plan' : stage],
    ]));
    const result = await compileGstackArtifacts({
      projectDir: parsed.project,
      outDir: parsed.out,
      artifacts,
      ...(parsed['created-at'] ? { createdAt: parsed['created-at'] } : {}),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 3;
  }
} catch (error) {
  const code = error instanceof GstackHarnessError ? error.code : 'unexpected_error';
  process.stderr.write(`agoragentic-gstack-harness: ${code}: ${error.message}\n`);
  process.exitCode = code === 'invalid_argument' ? 2 : 1;
}
