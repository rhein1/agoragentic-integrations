#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  DEFAULT_BASE_URL,
  DEFAULT_OUTPUT_DIR,
  premortemSessionFileNames,
  renderGoldenLoopMarkdown,
  renderHealingPlanMarkdown,
  renderPremortemMarkdown,
  renderPremortemSessionHtml,
  renderPremortemSessionSummary,
  renderPremortemSessionTranscript,
  renderSummaryMarkdown,
  runAll,
  runGoldenLoop,
  runHeal,
  runPremortem,
  runPremortemSession,
  writeJson,
  writeText
} from '../src/core.mjs';

const USAGE = `
Agoragentic Premortem Golden Loop

Usage:
  agoragentic-premortem-golden-loop run [options]
  agoragentic-premortem-golden-loop session --plan <text> --audience <who> --success <outcome>
  agoragentic-premortem-golden-loop heal [options]
  agoragentic-premortem-golden-loop premortem [options]
  agoragentic-premortem-golden-loop golden-loop [options]

Options:
  --repo <path>         Agent repository to inspect. Defaults to current directory.
  --out <path>          Output directory. Defaults to .agoragentic/premortem-golden-loop.
  --plan <text>         Plan, launch, product, hire, strategy, or decision to premortem.
  --plan-file <path>    File containing the plan context.
  --audience <text>     Who the plan is for or affects.
  --success <text>      What a win looks like.
  --base-url <url>      Agoragentic base URL for no-spend public canaries.
  --target-url <url>    Optional running agent URL to health/discovery probe.
  --allow-network-canaries
                       Opt in to public no-spend Agoragentic canaries. Sends no repo contents.
  --skip-network        Force local-only mode.
  --run-tests           Run package.json scripts.test with AGORAGENTIC_NO_SPEND=1.
  --apply-safe-fixes    For heal: create only missing additive docs/metadata/CI files.
  --open-report         Open the generated HTML report with the OS default app.
  --json                Print JSON to stdout.
  --ci                  Exit non-zero when blockers or Golden Loop failures remain.
  --fail-on <level>     never, blocker, warning. Defaults to never.
  --help                Show this help.
`;

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(USAGE.trimStart());
    return;
  }

  const command = parsed.command || 'run';
  const repo = path.resolve(parsed.repo || '.');
  const outDir = path.resolve(parsed.out || path.join(repo, DEFAULT_OUTPUT_DIR));
  const options = {
    repo,
    baseUrl: parsed.baseUrl || DEFAULT_BASE_URL,
    targetUrl: parsed.targetUrl || null,
    plan: parsed.plan || null,
    planFile: parsed.planFile || null,
    audience: parsed.audience || null,
    success: parsed.success || null,
    skipNetwork: parsed.skipNetwork,
    allowNetworkCanaries: parsed.allowNetworkCanaries,
    applySafeFixes: parsed.applySafeFixes,
    runTests: parsed.runTests
  };

  if (command === 'session') {
    const session = await runPremortemSession(options);
    if (session.status === 'needs_context') {
      await writeJson(path.join(outDir, 'premortem-context-needed.json'), session);
      emit(parsed, session, `Premortem needs more context: ${session.question}`);
      if (parsed.ci) process.exitCode = 1;
      return;
    }

    const names = premortemSessionFileNames(session.timestamp);
    const reportPath = path.join(outDir, names.report);
    const transcriptPath = path.join(outDir, names.transcript);
    await writeJson(path.join(outDir, names.json), session);
    await writeText(reportPath, renderPremortemSessionHtml(session));
    await writeText(transcriptPath, renderPremortemSessionTranscript(session));
    if (parsed.openReport) openReport(reportPath);
    emit(parsed, session, `Premortem report written to ${reportPath}\nTranscript written to ${transcriptPath}\n${renderPremortemSessionSummary(session)}`);
    return;
  }

  if (command === 'premortem') {
    const report = await runPremortem(options);
    await writeJson(path.join(outDir, 'premortem.json'), report);
    await writeText(path.join(outDir, 'premortem.md'), renderPremortemMarkdown(report));
    emit(parsed, report, `Premortem written to ${outDir}`);
    exitFor(parsed, report.summary.blockers, report.summary.warnings, 0);
    return;
  }

  if (command === 'golden-loop') {
    const report = await runGoldenLoop(options);
    await writeJson(path.join(outDir, 'golden-loop.json'), report);
    await writeText(path.join(outDir, 'golden-loop.md'), renderGoldenLoopMarkdown(report));
    emit(parsed, report, `Golden Loop receipt written to ${outDir}`);
    exitFor(parsed, report.summary.fail, report.summary.warn, report.summary.fail);
    return;
  }

  if (command === 'heal') {
    const report = await runHeal(options);
    await writeJson(path.join(outDir, 'healing-plan.json'), report);
    await writeText(path.join(outDir, 'healing-plan.md'), renderHealingPlanMarkdown(report));
    if (report.after) {
      await writeJson(path.join(outDir, 'healing-recheck.json'), report.after);
    }
    const created = report.applied.filter((item) => item.status === 'created').length;
    const suffix = parsed.applySafeFixes
      ? `Created ${created} safe file(s). Recheck written to ${outDir}.`
      : 'Plan only. No files changed. Pass --apply-safe-fixes to create safe missing scaffolds.';
    emit(parsed, report, `Self-heal artifacts written to ${outDir}\n${suffix}`);
    const effective = report.after || report.before;
    exitFor(parsed, effective.premortem.summary.blockers, effective.premortem.summary.warnings, effective.golden_loop.summary.fail);
    return;
  }

  if (command !== 'run') {
    throw new Error(`Unknown command: ${command}`);
  }

  const run = await runAll(options);
  await writeJson(path.join(outDir, 'premortem.json'), run.premortem);
  await writeText(path.join(outDir, 'premortem.md'), renderPremortemMarkdown(run.premortem));
  await writeJson(path.join(outDir, 'golden-loop.json'), run.golden_loop);
  await writeText(path.join(outDir, 'golden-loop.md'), renderGoldenLoopMarkdown(run.golden_loop));
  await writeJson(path.join(outDir, 'local-receipt.json'), run.receipt);
  await writeText(path.join(outDir, 'summary.md'), renderSummaryMarkdown(run));
  emit(parsed, run, `Premortem Golden Loop artifacts written to ${outDir}`);
  exitFor(parsed, run.premortem.summary.blockers, run.premortem.summary.warnings, run.golden_loop.summary.fail);
}

function parseArgs(argv) {
  const parsed = {
    command: null,
    repo: null,
    out: null,
    baseUrl: null,
    targetUrl: null,
    skipNetwork: false,
    allowNetworkCanaries: false,
    runTests: false,
    applySafeFixes: false,
    plan: null,
    planFile: null,
    audience: null,
    success: null,
    openReport: false,
    json: false,
    ci: false,
    failOn: 'never',
    help: false
  };

  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) parsed.command = args.shift();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--repo') parsed.repo = takeValue(args, ++index, arg);
    else if (arg === '--out') parsed.out = takeValue(args, ++index, arg);
    else if (arg === '--plan') parsed.plan = takeValue(args, ++index, arg);
    else if (arg === '--plan-file') parsed.planFile = takeValue(args, ++index, arg);
    else if (arg === '--audience') parsed.audience = takeValue(args, ++index, arg);
    else if (arg === '--success') parsed.success = takeValue(args, ++index, arg);
    else if (arg === '--base-url') parsed.baseUrl = takeValue(args, ++index, arg);
    else if (arg === '--target-url') parsed.targetUrl = takeValue(args, ++index, arg);
    else if (arg === '--skip-network') parsed.skipNetwork = true;
    else if (arg === '--allow-network-canaries') parsed.allowNetworkCanaries = true;
    else if (arg === '--run-tests') parsed.runTests = true;
    else if (arg === '--apply-safe-fixes') parsed.applySafeFixes = true;
    else if (arg === '--open-report') parsed.openReport = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--ci') parsed.ci = true;
    else if (arg === '--fail-on') parsed.failOn = takeValue(args, ++index, arg);
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!['never', 'blocker', 'warning'].includes(parsed.failOn)) {
    throw new Error('--fail-on must be never, blocker, or warning');
  }
  return parsed;
}

function takeValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
  return value;
}

function emit(parsed, value, text) {
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${text}\n`);
}

function exitFor(parsed, blockers, warnings, goldenLoopFailures) {
  const shouldFail = parsed.ci
    ? blockers > 0 || goldenLoopFailures > 0
    : parsed.failOn === 'blocker'
      ? blockers > 0 || goldenLoopFailures > 0
      : parsed.failOn === 'warning'
        ? blockers > 0 || warnings > 0 || goldenLoopFailures > 0
        : false;

  if (shouldFail) process.exitCode = 1;
}

function openReport(filePath) {
  const child = process.platform === 'win32'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'start', '', filePath], { detached: true, stdio: 'ignore' })
    : process.platform === 'darwin'
      ? spawn('open', [filePath], { detached: true, stdio: 'ignore' })
      : spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' });
  child.unref();
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${err.message || err}\n`);
  process.exitCode = 1;
});
