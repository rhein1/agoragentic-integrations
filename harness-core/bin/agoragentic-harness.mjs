#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import {
  createGuardReceipt,
  evaluateGuardAction,
  writeGuardReceipt,
} from '../src/vendor/guard-core.mjs';
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
import { decideApproval, listApprovals, showApproval } from '../src/kernel/approvals.mjs';
import { contextStatus, importContext } from '../src/kernel/context-import.mjs';
import { executeHarnessLoop } from '../src/kernel/loop.mjs';
import { listProfiles, loadProfile } from '../src/kernel/profiles.mjs';
import { executeHarnessRun, executeRuntimeProbeRun } from '../src/kernel/run.mjs';
import { checkDueHarnessSchedules, listHarnessSchedules, planHarnessSchedule } from '../src/kernel/schedule.mjs';
import { latestRunState, listRunStates, readRunEvents, readRunState } from '../src/kernel/state.mjs';
import { buildHarnessStatus, writeHarnessStatus } from '../src/kernel/status.mjs';
import { decideReview, initReviewGates, listReviewGates, requestReview, reviewGateStatus } from '../src/kernel/review-gates.mjs';
import { initToolManifest, inspectTool, listTools, toolManifestStatus } from '../src/kernel/tool-manifest.mjs';
import { decideImprovement, listImprovements, ownerInboxStatus, suggestImprovements } from '../src/kernel/improvement-candidates.mjs';
import { budgetPolicyStatus, initBudgetPolicy } from '../src/middleware/budget-limit.mjs';
import { initRetryPolicy, retryPolicyStatus } from '../src/middleware/retry-policy.mjs';
import { decideClaudeCodeToolCall, recordHookDecision } from '../src/adapters/claude-code.mjs';
import { attachWorktreeSession, detachWorktreeSession, getWorktreeSessionStatus } from '../src/kernel/worktree-session.mjs';

function usage() {
  return `Agoragentic Harness Core

Usage:
  agoragentic-harness init [template] [--dir <path>] [--force]
  agoragentic-harness validate [--dir <path>]
  agoragentic-harness proof [--dir <path>] [--record]
  agoragentic-harness run [--dir <path>] [--profile <id>] [--task <text>] [--probe-runtime <url>]
  agoragentic-harness loop seller-listing-readiness [--dir <path>] [--once] [--write-inbox]
  agoragentic-harness schedule plan seller-listing-readiness --interval daily [--dir <path>]
  agoragentic-harness schedule list [--dir <path>]
  agoragentic-harness schedule due [--dir <path>]
  agoragentic-harness worktree attach --path <path> --branch <branch> [--commit <sha>] [--pr-number <n>] [--pr-url <url>] [--dirty-state clean|dirty|unknown] [--dir <path>]
  agoragentic-harness worktree status [--dir <path>]
  agoragentic-harness worktree detach [--dir <path>]
  agoragentic-harness review gates init [--maker <label>] [--checker <label>] [--dir <path>]
  agoragentic-harness review request --gate listing-readiness [--maker <label>] [--checker <label>] [--dir <path>]
  agoragentic-harness review decide <review_id> --decision approve|reject|needs_changes --checker <label> [--note <text>] [--dir <path>]
  agoragentic-harness review list [--dir <path>]
  agoragentic-harness export --to agent-os [--dir <path>]
  agoragentic-harness listing check [--dir <path>]
  agoragentic-harness guard check --policy <guard-policy.json> --action <action.json> [--write-receipt] [--dir <path>]
  agoragentic-harness runtime probe --url <url> [--contract agoragentic-rust-http] [--dir <path>]
  agoragentic-harness context import --from micro-ecf|ecf-core [--dir <path>]
  agoragentic-harness context status [--dir <path>]
  agoragentic-harness approvals list|show|decide ... [--dir <path>]
  agoragentic-harness runs list|show ... [--dir <path>]
  agoragentic-harness events tail [--dir <path>] [--run <run_id>] [--limit 50]
  agoragentic-harness profiles list|show ...
  agoragentic-harness status [--dir <path>] [--write]
  agoragentic-harness adapters
  agoragentic-harness review init|list|status [--dir <path>]
  agoragentic-harness review request --gate <id> [--maker <label>] [--dir <path>]
  agoragentic-harness review decide <review_id> --decision <approve|reject|needs_changes> --checker <label> [--note <text>] [--dir <path>]
  agoragentic-harness tools manifest init [--dir <path>]
  agoragentic-harness tools list|status [--dir <path>]
  agoragentic-harness tools inspect <tool_id> [--dir <path>]
  agoragentic-harness improve suggest|list [--dir <path>]
  agoragentic-harness improve decide <candidate_id> --decision <accept|reject|defer> [--dir <path>]
  agoragentic-harness owner-inbox [--dir <path>]
  agoragentic-harness budget init|status [--dir <path>]
  agoragentic-harness retry init|status [--dir <path>]
  agoragentic-harness hook pretooluse [--dir <path>]   (reads a Claude Code PreToolUse payload on stdin, returns allow/ask/deny)
  agoragentic-harness hooks config                     (prints the settings.json snippet for live enforcement)

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
    policy: null,
    action: null,
    writeReceipt: false,
    record: false,
    profile: 'local_no_spend',
    task: null,
    probeRuntime: null,
    url: null,
    contract: 'agoragentic-rust-http',
    from: null,
    run: null,
    limit: 50,
    decision: null,
    note: '',
    write: false,
    json: false,
    gate: null,
    maker: null,
    checker: null,
    once: true,
    writeInbox: true,
    interval: 'daily',
    worktreePath: null,
    branch: null,
    commit: null,
    prNumber: null,
    prUrl: null,
    dirtyState: 'unknown',
    ownerReviewState: 'pending_owner_review',
  };

  while (args.length) {
    const token = args.shift();
    if (token === '--dir') parsed.dir = args.shift() || parsed.dir;
    else if (token === '--force') parsed.force = true;
    else if (token === '--to') parsed.to = args.shift() || null;
    else if (token === '--policy') parsed.policy = args.shift() || null;
    else if (token === '--action') parsed.action = args.shift() || null;
    else if (token === '--write-receipt') parsed.writeReceipt = true;
    else if (token === '--record') parsed.record = true;
    else if (token === '--profile') parsed.profile = args.shift() || parsed.profile;
    else if (token === '--task') parsed.task = args.shift() || null;
    else if (token === '--probe-runtime') parsed.probeRuntime = args.shift() || null;
    else if (token === '--url') parsed.url = args.shift() || null;
    else if (token === '--contract') parsed.contract = args.shift() || parsed.contract;
    else if (token === '--from') parsed.from = args.shift() || null;
    else if (token === '--run') parsed.run = args.shift() || null;
    else if (token === '--limit') parsed.limit = Number(args.shift() || parsed.limit);
    else if (token === '--decision') parsed.decision = args.shift() || null;
    else if (token === '--note') parsed.note = args.shift() || '';
    else if (token === '--write') parsed.write = true;
    else if (token === '--json') parsed.json = true;
    else if (token === '--gate') parsed.gate = args.shift() || null;
    else if (token === '--maker') parsed.maker = args.shift() || null;
    else if (token === '--checker') parsed.checker = args.shift() || null;
    else if (token === '--once') parsed.once = true;
    else if (token === '--write-inbox') parsed.writeInbox = true;
    else if (token === '--interval') parsed.interval = args.shift() || parsed.interval;
    else if (token === '--path') parsed.worktreePath = args.shift() || null;
    else if (token === '--branch') parsed.branch = args.shift() || null;
    else if (token === '--commit') parsed.commit = args.shift() || null;
    else if (token === '--pr-number') parsed.prNumber = args.shift() || null;
    else if (token === '--pr-url') parsed.prUrl = args.shift() || null;
    else if (token === '--dirty-state') parsed.dirtyState = args.shift() || parsed.dirtyState;
    else if (token === '--owner-review-state') parsed.ownerReviewState = args.shift() || parsed.ownerReviewState;
    else parsed.positional.push(token);
  }

  return parsed;
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function hookReason(evaluation) {
  if (evaluation.decision === 'allow') {
    return 'Allowed by Agoragentic harness policy (read-only / no side effects).';
  }
  const codes = (evaluation.reasons || []).map((entry) => entry.code).join(', ');
  return `Agoragentic harness ${evaluation.decision}: ${codes || evaluation.decision}`;
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

  if (parsed.command === 'proof' && parsed.record) {
    const result = await executeHarnessRun({
      dir: parsed.dir,
      profile: parsed.profile,
      task: parsed.task,
      probe_runtime: parsed.probeRuntime,
      probe_contract: parsed.contract,
    });
    printJson(result);
    return result.ok ? 0 : result.status === 'blocked' ? 2 : 1;
  }

  if (parsed.command === 'proof') {
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

  if (parsed.command === 'run') {
    const result = await executeHarnessRun({
      dir: parsed.dir,
      profile: parsed.profile,
      task: parsed.task,
      probe_runtime: parsed.probeRuntime,
      probe_contract: parsed.contract,
    });
    printJson(result);
    return result.ok ? 0 : result.status === 'blocked' ? 2 : 1;
  }

  if (parsed.command === 'loop') {
    const result = await executeHarnessLoop({
      dir: parsed.dir,
      loop: parsed.positional[0],
      once: parsed.once,
      write_inbox: parsed.writeInbox,
      task: parsed.task,
    });
    printJson(result);
    return result.ok ? 0 : result.status === 'blocked' ? 2 : 1;
  }

  if (parsed.command === 'schedule' && parsed.positional[0] === 'plan') {
    const result = await planHarnessSchedule({
      dir: parsed.dir,
      loop: parsed.positional[1],
      interval: parsed.interval,
    });
    printJson(result);
    return 0;
  }

  if (parsed.command === 'schedule' && parsed.positional[0] === 'list') {
    printJson(await listHarnessSchedules({ dir: parsed.dir }));
    return 0;
  }

  if (parsed.command === 'schedule' && parsed.positional[0] === 'due') {
    printJson(await checkDueHarnessSchedules({ dir: parsed.dir }));
    return 0;
  }

  if (parsed.command === 'worktree' && parsed.positional[0] === 'attach') {
    const result = await attachWorktreeSession({
      dir: parsed.dir,
      worktree_path: parsed.worktreePath,
      branch: parsed.branch,
      commit_sha: parsed.commit,
      pr_number: parsed.prNumber,
      pr_url: parsed.prUrl,
      dirty_state: parsed.dirtyState,
      owner_review_state: parsed.ownerReviewState,
    });
    printJson(result);
    return 0;
  }

  if (parsed.command === 'worktree' && parsed.positional[0] === 'status') {
    printJson(await getWorktreeSessionStatus({ dir: parsed.dir }));
    return 0;
  }

  if (parsed.command === 'worktree' && parsed.positional[0] === 'detach') {
    printJson(await detachWorktreeSession({ dir: parsed.dir }));
    return 0;
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

  if (parsed.command === 'guard' && parsed.positional[0] === 'check') {
    if (!parsed.policy || !parsed.action) {
      printJson({ ok: false, error: 'missing_policy_or_action', usage: 'agoragentic-harness guard check --policy <file> --action <file>' });
      return 1;
    }
    const policy = JSON.parse(await readFile(parsed.policy, 'utf8'));
    const action = JSON.parse(await readFile(parsed.action, 'utf8'));
    const decision = evaluateGuardAction(policy, action);
    const payload = { ok: decision.verdict === 'allow', decision };
    if (parsed.writeReceipt) {
      const receipt = createGuardReceipt(policy, action, decision);
      payload.receipt_path = await writeGuardReceipt(parsed.dir, receipt);
      payload.receipt = receipt;
    }
    printJson(payload);
    if (decision.verdict === 'allow') return 0;
    if (decision.verdict === 'needs_approval') return 2;
    return 3;
  }

  if (parsed.command === 'adapters') {
    printJson({ ok: true, adapters: adapterCatalog() });
    return 0;
  }

  if (parsed.command === 'runtime' && parsed.positional[0] === 'probe') {
    const result = await executeRuntimeProbeRun({
      dir: parsed.dir,
      url: parsed.url,
      contract: parsed.contract,
    });
    printJson(result);
    return result.ok ? 0 : 2;
  }

  if (parsed.command === 'context' && parsed.positional[0] === 'import') {
    const result = await importContext({ dir: parsed.dir, source: parsed.from });
    printJson({ ok: true, import_path: `.agoragentic/context-imports/${parsed.from}.json`, context_import: result.payload });
    return 0;
  }

  if (parsed.command === 'context' && parsed.positional[0] === 'status') {
    printJson({ ok: true, status: await contextStatus(parsed.dir) });
    return 0;
  }

  if (parsed.command === 'approvals' && parsed.positional[0] === 'list') {
    printJson({ ok: true, approvals: await listApprovals(parsed.dir) });
    return 0;
  }

  if (parsed.command === 'approvals' && parsed.positional[0] === 'show') {
    const approval = await showApproval(parsed.dir, parsed.positional[1]);
    if (!approval) {
      printJson({ ok: false, error: 'approval_not_found' });
      return 1;
    }
    printJson({ ok: true, approval });
    return 0;
  }

  if (parsed.command === 'approvals' && parsed.positional[0] === 'decide') {
    const decision = await decideApproval({
      dir: parsed.dir,
      approval_id: parsed.positional[1],
      decision: parsed.decision,
      note: parsed.note,
    });
    printJson({ ok: true, decision });
    return 0;
  }

  if (parsed.command === 'runs' && parsed.positional[0] === 'list') {
    printJson({ ok: true, runs: await listRunStates(parsed.dir) });
    return 0;
  }

  if (parsed.command === 'runs' && parsed.positional[0] === 'show') {
    const state = await readRunState(parsed.dir, parsed.positional[1]);
    if (!state) {
      printJson({ ok: false, error: 'run_not_found' });
      return 1;
    }
    printJson({ ok: true, run: state });
    return 0;
  }

  if (parsed.command === 'events' && parsed.positional[0] === 'tail') {
    const run = parsed.run ? await readRunState(parsed.dir, parsed.run) : await latestRunState(parsed.dir);
    if (!run) {
      printJson({ ok: false, error: 'run_not_found' });
      return 1;
    }
    printJson({ ok: true, run_id: run.run_id, events: await readRunEvents(parsed.dir, run.run_id, { limit: parsed.limit }) });
    return 0;
  }

  if (parsed.command === 'profiles' && parsed.positional[0] === 'list') {
    printJson({ ok: true, profiles: await listProfiles() });
    return 0;
  }

  if (parsed.command === 'profiles' && parsed.positional[0] === 'show') {
    printJson({ ok: true, profile: await loadProfile(parsed.positional[1] || parsed.profile) });
    return 0;
  }

  if (parsed.command === 'status') {
    const status = await buildHarnessStatus({ dir: parsed.dir });
    if (parsed.write) {
      printJson({ ok: true, ...(await writeHarnessStatus({ dir: parsed.dir, status })) });
    } else {
      printJson({ ok: true, status });
    }
    return 0;
  }

  if (parsed.command === 'review' && parsed.positional[0] === 'init') {
    const result = await initReviewGates({ dir: parsed.dir });
    printJson({ ok: true, path: result.path, created: result.created, gates: Object.keys(result.artifact.gates || {}) });
    return 0;
  }

  if (parsed.command === 'review' && parsed.positional[0] === 'list') {
    printJson({ ok: true, review_gates: await listReviewGates(parsed.dir) });
    return 0;
  }

  if (parsed.command === 'review' && parsed.positional[0] === 'status') {
    printJson({ ok: true, status: await reviewGateStatus(parsed.dir) });
    return 0;
  }

  if (parsed.command === 'review' && parsed.positional[0] === 'request') {
    const result = await requestReview({ dir: parsed.dir, gate_id: parsed.gate, maker_label: parsed.maker || 'local_maker' });
    printJson({ ok: true, review: result.request });
    return result.request.missing_required_evidence_refs.length ? 2 : 0;
  }

  if (parsed.command === 'review' && parsed.positional[0] === 'decide') {
    const result = await decideReview({
      dir: parsed.dir,
      review_id: parsed.positional[1],
      decision: parsed.decision,
      checker_label: parsed.checker,
      note: parsed.note,
    });
    printJson({ ok: true, decision: result.decision });
    return result.decision.decision === 'approve' ? 0 : 2;
  }

  if (parsed.command === 'tools' && parsed.positional[0] === 'manifest' && parsed.positional[1] === 'init') {
    const result = await initToolManifest({ dir: parsed.dir });
    printJson({ ok: true, path: result.path, created: result.created, summary: result.artifact.summary });
    return 0;
  }

  if (parsed.command === 'tools' && parsed.positional[0] === 'list') {
    printJson({ ok: true, tools: await listTools(parsed.dir) });
    return 0;
  }

  if (parsed.command === 'tools' && parsed.positional[0] === 'status') {
    printJson({ ok: true, status: await toolManifestStatus(parsed.dir) });
    return 0;
  }

  if (parsed.command === 'tools' && parsed.positional[0] === 'inspect') {
    if (!parsed.positional[1]) {
      printJson({ ok: false, error: 'missing_tool_id', usage: 'agoragentic-harness tools inspect <tool_id>' });
      return 1;
    }
    printJson({ ok: true, tool: await inspectTool({ dir: parsed.dir, tool_id: parsed.positional[1] }) });
    return 0;
  }

  if (parsed.command === 'improve' && parsed.positional[0] === 'suggest') {
    const result = await suggestImprovements({ dir: parsed.dir });
    printJson({ ok: true, path: result.path, new_candidates: result.new_candidates, summary: result.artifact.summary });
    return 0;
  }

  if (parsed.command === 'improve' && parsed.positional[0] === 'list') {
    printJson({ ok: true, improvements: await listImprovements(parsed.dir) });
    return 0;
  }

  if (parsed.command === 'improve' && parsed.positional[0] === 'decide') {
    const result = await decideImprovement({ dir: parsed.dir, candidate_id: parsed.positional[1], decision: parsed.decision });
    printJson({ ok: true, decision: result.decision });
    return 0;
  }

  if (parsed.command === 'owner-inbox') {
    printJson({ ok: true, owner_inbox: await ownerInboxStatus(parsed.dir) });
    return 0;
  }

  if (parsed.command === 'budget' && parsed.positional[0] === 'init') {
    const result = await initBudgetPolicy({ dir: parsed.dir });
    printJson({ ok: true, path: result.path, created: result.created, limits: result.artifact.limits });
    return 0;
  }

  if (parsed.command === 'budget' && (parsed.positional[0] === 'status' || !parsed.positional[0])) {
    printJson({ ok: true, status: await budgetPolicyStatus(parsed.dir) });
    return 0;
  }

  if (parsed.command === 'retry' && parsed.positional[0] === 'init') {
    const result = await initRetryPolicy({ dir: parsed.dir });
    printJson({ ok: true, path: result.path, created: result.created, blocked_tool_ids: result.artifact.blocked_tool_ids });
    return 0;
  }

  if (parsed.command === 'retry' && (parsed.positional[0] === 'status' || !parsed.positional[0])) {
    printJson({ ok: true, status: await retryPolicyStatus(parsed.dir) });
    return 0;
  }

  if (parsed.command === 'hook' && ['pretooluse', 'pre-tool-use', 'PreToolUse'].includes(parsed.positional[0])) {
    const raw = await readStdin();
    let payload = {};
    try {
      payload = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      payload = {};
    }
    const projectDir = payload.cwd || parsed.dir;
    let policy = {};
    try {
      const project = await loadProject(projectDir);
      policy = project.policy || {};
    } catch {
      policy = {}; // No harness project found: fall back to built-in safe defaults.
    }
    const evaluation = decideClaudeCodeToolCall(policy, payload);
    try {
      await recordHookDecision({ dir: projectDir, payload, evaluation });
    } catch {
      // Never break the host agent because evidence logging failed.
    }
    // STDOUT must be ONLY the hook decision JSON (Claude Code parses it verbatim).
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: evaluation.decision,
        permissionDecisionReason: hookReason(evaluation),
      },
    })}\n`);
    return 0;
  }

  if (parsed.command === 'hooks' && parsed.positional[0] === 'config') {
    printJson({
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [
              { type: 'command', command: 'npx agoragentic-harness-core hook pretooluse' },
            ],
          },
        ],
      },
    });
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
