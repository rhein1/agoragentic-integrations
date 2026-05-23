#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_BASE_URL,
  DEFAULT_OUTPUT_DIR,
  buildArtifacts,
  buildEcfSpec,
  buildExplanation,
  buildInstallPlan,
  diffEcfMd,
  doctorProject,
  exportAgentOsHarness,
  indexSources,
  installProject,
  initProject,
  lintEcfMd,
  readJson,
  readPolicy,
  scanProject,
  searchSourceMap,
  writeJson,
} from '../src/core.mjs';
import {
  buildMicroEcfContextPack,
  buildMicroEcfMcpConfig,
  buildMicroEcfResidentStatus,
  writeMicroEcfContextPack,
  writeMicroEcfMcpConfig,
  writeMicroEcfResidentStatus,
} from '../src/resident.mjs';
import {
  beginWorklog,
  buildHandoff,
  buildWorklogStatus,
  checkpointWorklog,
  finishWorklog,
  planDocsSync,
  writeHandoff,
} from '../src/work-memory.mjs';
import { startStdioMcpServer } from '../src/mcp-server.mjs';

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      flags._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === 'force' || key === 'agent-os' || key === 'json' || key === 'yes' || key === 'write' || key === 'install-codex') {
      flags[key] = true;
    } else {
      flags[key] = argv[++i];
    }
  }
  return flags;
}

function printHelp() {
  console.log(`Micro ECF - local context and policy packets for safer agents

Usage:
  micro-ecf init [--dir .] [--force]
  micro-ecf explain
  micro-ecf plan [--dir .] [--output-dir .micro-ecf]
  micro-ecf install [--dir .] [--output-dir .micro-ecf] [--yes]
  micro-ecf scan [--dir .] [--policy .micro-ecf/policy.json]
  micro-ecf doctor [--dir .] [--output-dir .micro-ecf]
  micro-ecf status [--dir .] [--output-dir .micro-ecf] [--write]
  micro-ecf context-pack [task] [--dir .] [--output-dir .micro-ecf] [--write]
  micro-ecf mcp-config --target codex [--dir .] [--output-dir .micro-ecf] [--write] [--install-codex]
  micro-ecf worklog begin --goal "..." [--dir .] [--output-dir .micro-ecf]
  micro-ecf worklog checkpoint --summary "..." [--dir .] [--output-dir .micro-ecf]
  micro-ecf worklog finish --summary "..." [--commit abc123] [--tests "npm test"] [--dir .]
  micro-ecf docs-sync plan [--dir .] [--output-dir .micro-ecf]
  micro-ecf handoff [--dir .] [--output-dir .micro-ecf] [--write]
  micro-ecf lint [ECF.md]
  micro-ecf diff <before ECF.md> <after ECF.md>
  micro-ecf spec [--json]
  micro-ecf index <path> [--policy .micro-ecf/policy.json] [--output-dir .micro-ecf]
  micro-ecf build-packet [--policy .micro-ecf/policy.json] [--source-map .micro-ecf/source-map.json] [--output-dir .micro-ecf]
  micro-ecf export --agent-os [--policy .micro-ecf/policy.json] [--output .micro-ecf/harness-export.json]
  micro-ecf serve-mcp [--root .micro-ecf]

LLM-safe install flow:
  1. Run micro-ecf explain or micro-ecf plan first.
  2. Show the plan to the developer.
  3. Only run micro-ecf install --yes after explicit approval.

Micro ECF is local-only. It does not deploy, spend, publish, provision, rank providers, settle x402, or expose Full ECF internals.
`);
}

function output(value, asJson = true) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    process.stdout.write(`${String(value)}\n`);
  }
}

function commandInit(flags) {
  return initProject({
    targetDir: flags.dir || process.cwd(),
    force: flags.force === true,
  });
}

function commandPlan(flags) {
  return buildInstallPlan({
    targetDir: flags.dir || process.cwd(),
    outputDir: flags['output-dir'] || null,
    force: flags.force === true,
  });
}

function commandInstall(flags) {
  return installProject({
    targetDir: flags.dir || process.cwd(),
    outputDir: flags['output-dir'] || null,
    force: flags.force === true,
    approved: flags.yes === true,
    maxFiles: flags['max-files'],
    maxFileBytes: flags['max-file-bytes'],
    baseUrl: flags['base-url'] || DEFAULT_BASE_URL,
  });
}

function commandScan(flags) {
  return scanProject({
    targetDir: flags.dir || flags._[0] || process.cwd(),
    policyPath: flags.policy || null,
    maxFiles: flags['max-files'],
    maxFileBytes: flags['max-file-bytes'],
  });
}

function commandDoctor(flags) {
  return doctorProject({
    targetDir: flags.dir || process.cwd(),
    outputDir: flags['output-dir'] || null,
  });
}

function commandIndex(flags) {
  const inputPath = flags._[0] || process.cwd();
  const outputDir = path.resolve(flags['output-dir'] || DEFAULT_OUTPUT_DIR);
  const policyPath = flags.policy || path.join(outputDir, 'policy.json');
  const sourceMap = indexSources(inputPath, {
    policyPath,
    maxFiles: flags['max-files'],
    maxFileBytes: flags['max-file-bytes'],
  });
  const outputPath = writeJson(path.join(outputDir, 'source-map.json'), sourceMap);
  return {
    ok: true,
    output: path.relative(process.cwd(), outputPath).replace(/\\/g, '/'),
    stats: sourceMap.stats,
  };
}

function commandBuildPacket(flags) {
  const outputDir = flags['output-dir'] || DEFAULT_OUTPUT_DIR;
  return buildArtifacts({
    policyPath: flags.policy || path.join(outputDir, 'policy.json'),
    sourceMapPath: flags['source-map'] || path.join(outputDir, 'source-map.json'),
    outputDir,
  });
}

function commandExport(flags) {
  if (!flags['agent-os']) {
    throw new Error('Only --agent-os export is supported in Micro ECF v1.');
  }
  const outputDir = flags['output-dir'] || DEFAULT_OUTPUT_DIR;
  const outputPath = flags.output || path.join(outputDir, 'harness-export.json');
  const policyPath = flags.policy || path.join(outputDir, 'policy.json');
  const artifactRefs = {
    context_packet: flags['context-packet'] || `${DEFAULT_OUTPUT_DIR}/context-packet.json`,
    policy_summary: flags['policy-summary'] || `${DEFAULT_OUTPUT_DIR}/policy-summary.json`,
    source_map: flags['source-map'] || `${DEFAULT_OUTPUT_DIR}/source-map.json`,
    deployment_preview: flags['deployment-preview'] || `${DEFAULT_OUTPUT_DIR}/deployment-preview.json`,
  };

  const { output: written } = exportAgentOsHarness({
    policyPath,
    outputPath,
    baseUrl: flags['base-url'] || DEFAULT_BASE_URL,
    artifactRefs,
  });

  return {
    ok: true,
    output: path.relative(process.cwd(), written).replace(/\\/g, '/'),
    next_step: `npx agoragentic-os preview ${path.relative(process.cwd(), written).replace(/\\/g, '/')}`,
  };
}

function commandSearch(flags) {
  const root = path.resolve(flags.root || DEFAULT_OUTPUT_DIR);
  const sourceMap = readJson(path.join(root, 'source-map.json'));
  return searchSourceMap(sourceMap, flags.query || flags._.join(' '), Number(flags.limit || 10));
}

function commandStatus(flags) {
  const options = {
    targetDir: flags.dir || process.cwd(),
    outputDir: flags['output-dir'] || null,
  };
  return flags.write ? writeMicroEcfResidentStatus(options) : buildMicroEcfResidentStatus(options);
}

function commandContextPack(flags) {
  const options = {
    targetDir: flags.dir || process.cwd(),
    outputDir: flags['output-dir'] || null,
    task: flags.task || flags._.join(' '),
  };
  return flags.write ? writeMicroEcfContextPack(options) : buildMicroEcfContextPack(options);
}

function commandMcpConfig(flags) {
  const options = {
    targetDir: flags.dir || process.cwd(),
    outputDir: flags['output-dir'] || null,
    target: flags.target || 'codex',
    codexHome: flags['codex-home'] || null,
    serverName: flags['server-name'] || null,
    installCodex: flags['install-codex'] === true,
  };
  return (flags.write || flags['install-codex'])
    ? writeMicroEcfMcpConfig(options)
    : buildMicroEcfMcpConfig(options);
}

function workMemoryOptions(flags) {
  return {
    targetDir: flags.dir || process.cwd(),
    outputDir: flags['output-dir'] || null,
    goal: flags.goal,
    summary: flags.summary,
    workId: flags.id || flags['work-id'],
    decisions: flags.decisions,
    files: flags.files,
    validation: flags.validation,
    tests: flags.tests,
    unfinished: flags.unfinished,
    nextPrompt: flags['next-prompt'],
    commit: flags.commit,
  };
}

function commandWorklog(flags) {
  const [subcommand] = flags._;
  if (subcommand === 'begin') return beginWorklog(workMemoryOptions(flags));
  if (subcommand === 'checkpoint') return checkpointWorklog(workMemoryOptions(flags));
  if (subcommand === 'finish') return finishWorklog(workMemoryOptions(flags));
  if (!subcommand || subcommand === 'status') return buildWorklogStatus(workMemoryOptions(flags));
  throw new Error(`Unknown worklog subcommand: ${subcommand}`);
}

function commandDocsSync(flags) {
  const [subcommand] = flags._;
  if (subcommand === 'plan') return planDocsSync(workMemoryOptions(flags));
  throw new Error(`Unknown docs-sync subcommand: ${subcommand || '<missing>'}`);
}

function commandHandoff(flags) {
  return flags.write ? writeHandoff(workMemoryOptions(flags)) : buildHandoff(workMemoryOptions(flags));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const flags = parseFlags(rest);

  if (command === 'init') output(commandInit(flags));
  else if (command === 'explain') output(buildExplanation());
  else if (command === 'plan') output(commandPlan(flags));
  else if (command === 'install') output(commandInstall(flags));
  else if (command === 'scan') output(commandScan(flags));
  else if (command === 'doctor') output(commandDoctor(flags));
  else if (command === 'status') output(commandStatus(flags));
  else if (command === 'context-pack') output(commandContextPack(flags));
  else if (command === 'mcp-config') output(commandMcpConfig(flags));
  else if (command === 'worklog') output(commandWorklog(flags));
  else if (command === 'docs-sync') output(commandDocsSync(flags));
  else if (command === 'handoff') output(commandHandoff(flags));
  else if (command === 'lint') output(lintEcfMd(flags._[0] || 'ECF.md'));
  else if (command === 'diff') {
    if (!flags._[0] || !flags._[1]) throw new Error('diff requires two ECF.md file paths.');
    output(diffEcfMd(flags._[0], flags._[1]));
  } else if (command === 'spec') {
    const spec = buildEcfSpec({ format: flags.json ? 'json' : 'markdown' });
    output(spec, flags.json === true);
  }
  else if (command === 'index') output(commandIndex(flags));
  else if (command === 'build-packet') output(commandBuildPacket(flags));
  else if (command === 'export') output(commandExport(flags));
  else if (command === 'search') output(commandSearch(flags));
  else if (command === 'validate-policy') {
    const { resolved } = readPolicy(flags.policy || flags._[0] || path.join(DEFAULT_OUTPUT_DIR, 'policy.json'));
    output({ ok: true, policy: path.relative(process.cwd(), resolved).replace(/\\/g, '/') });
  } else if (command === 'serve-mcp') {
    await startStdioMcpServer({ root: path.resolve(flags.root || DEFAULT_OUTPUT_DIR) });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
});
