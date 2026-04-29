#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_BASE_URL,
  DEFAULT_OUTPUT_DIR,
  buildHarnessPacket,
  readPolicy,
  writeJson,
} from './src/core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY = path.join(__dirname, 'policy.example.json');

function parseArgs(argv) {
  const args = {
    policy: DEFAULT_POLICY,
    output: null,
    baseUrl: DEFAULT_BASE_URL,
    artifactRefs: {},
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--policy') args.policy = argv[++i];
    else if (arg === '--output') args.output = argv[++i];
    else if (arg === '--base-url') args.baseUrl = argv[++i];
    else if (arg === '--context-packet') args.artifactRefs.context_packet = argv[++i];
    else if (arg === '--policy-summary') args.artifactRefs.policy_summary = argv[++i];
    else if (arg === '--source-map') args.artifactRefs.source_map = argv[++i];
    else if (arg === '--deployment-preview') args.artifactRefs.deployment_preview = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node micro-ecf/export-agent-os-harness.mjs --policy micro-ecf/policy.example.json --output ./agent-os-harness.packet.json

Options:
  --policy <path>               Micro ECF policy JSON. Defaults to micro-ecf/policy.example.json.
  --output <path>               Write packet to a file. Defaults to stdout.
  --base-url <url>              Agoragentic base URL. Defaults to https://agoragentic.com.
  --context-packet <path>       Optional local context-packet artifact ref.
  --policy-summary <path>       Optional local policy-summary artifact ref.
  --source-map <path>           Optional local source-map artifact ref.
  --deployment-preview <path>   Optional local deployment-preview artifact ref.

For the package-ready CLI, use:
  micro-ecf export --agent-os
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { policy, resolved } = readPolicy(args.policy);
  const packet = buildHarnessPacket(policy, {
    baseUrl: args.baseUrl,
    policyPath: path.relative(process.cwd(), resolved).replace(/\\/g, '/'),
    artifactRefs: {
      context_packet: args.artifactRefs.context_packet || `${DEFAULT_OUTPUT_DIR}/context-packet.json`,
      policy_summary: args.artifactRefs.policy_summary || `${DEFAULT_OUTPUT_DIR}/policy-summary.json`,
      source_map: args.artifactRefs.source_map || `${DEFAULT_OUTPUT_DIR}/source-map.json`,
      deployment_preview: args.artifactRefs.deployment_preview || `${DEFAULT_OUTPUT_DIR}/deployment-preview.json`,
    },
  });

  if (args.output) {
    const outputPath = writeJson(args.output, packet);
    console.log(JSON.stringify({ ok: true, output: outputPath }, null, 2));
  } else {
    process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
  }
}

try {
  main();
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
}
