#!/usr/bin/env node
import {
  adapterCatalog,
  buildAgentOsExport,
  checkListingReadiness,
  createLocalProof,
  createLocalReceipt,
  initProject,
  loadProject,
  runValidation,
  writeJsonArtifact,
} from '../src/index.mjs';

function usage() {
  return `Agoragentic Harness Core

Usage:
  agoragentic-harness init [template] [--dir <path>] [--force]
  agoragentic-harness validate [--dir <path>]
  agoragentic-harness proof [--dir <path>]
  agoragentic-harness run [--dir <path>]
  agoragentic-harness export --to agent-os [--dir <path>]
  agoragentic-harness listing check [--dir <path>]
  agoragentic-harness adapters

Default template: codebase_maintenance
Safety: all commands are local and no-spend.`;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const parsed = {
    command,
    positional: [],
    dir: process.cwd(),
    force: false,
    to: null,
  };

  while (args.length) {
    const token = args.shift();
    if (token === '--dir') parsed.dir = args.shift() || parsed.dir;
    else if (token === '--force') parsed.force = true;
    else if (token === '--to') parsed.to = args.shift() || null;
    else parsed.positional.push(token);
  }

  return parsed;
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (!parsed.command || parsed.command === '--help' || parsed.command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (parsed.command === 'init') {
    const template = parsed.positional[0] || 'codebase_maintenance';
    const result = await initProject({ dir: parsed.dir, template, force: parsed.force });
    printJson(result);
    return 0;
  }

  if (parsed.command === 'validate') {
    const project = await loadProject(parsed.dir);
    const result = runValidation(project);
    printJson(result);
    return result.ok ? 0 : 1;
  }

  if (parsed.command === 'proof' || parsed.command === 'run') {
    const project = await loadProject(parsed.dir);
    const validation = runValidation(project);
    if (!validation.ok) {
      printJson(validation);
      return 1;
    }
    const proof = createLocalProof(project);
    const receipt = createLocalReceipt(project, proof);
    await writeJsonArtifact(parsed.dir, 'local-proof.json', proof);
    await writeJsonArtifact(parsed.dir, 'local-receipt.json', receipt);
    printJson({ ok: true, proof_path: '.agoragentic/local-proof.json', receipt_path: '.agoragentic/local-receipt.json', proof, receipt });
    return proof.status === 'blocked' ? 2 : 0;
  }

  if (parsed.command === 'export') {
    if (parsed.to !== 'agent-os') {
      printJson({ ok: false, error: 'unsupported_export_target', expected: '--to agent-os' });
      return 1;
    }
    const project = await loadProject(parsed.dir);
    const validation = runValidation(project);
    if (!validation.ok) {
      printJson(validation);
      return 1;
    }
    const packet = buildAgentOsExport(project);
    await writeJsonArtifact(parsed.dir, 'agent-os-harness.json', packet);
    printJson({ ok: true, export_path: '.agoragentic/agent-os-harness.json', packet });
    return 0;
  }

  if (parsed.command === 'listing' && parsed.positional[0] === 'check') {
    const project = await loadProject(parsed.dir);
    const readiness = await checkListingReadiness(project, parsed.dir);
    await writeJsonArtifact(parsed.dir, 'listing-readiness.json', readiness);
    printJson({ ok: readiness.status !== 'blocked', readiness_path: '.agoragentic/listing-readiness.json', readiness });
    return readiness.status === 'blocked' ? 2 : 0;
  }

  if (parsed.command === 'adapters') {
    printJson({ ok: true, adapters: adapterCatalog() });
    return 0;
  }

  process.stderr.write(`${usage()}\n`);
  return 1;
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});
