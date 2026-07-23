import path from 'node:path';
import {
  buildAgentOsExport,
  createLocalProof,
  createLocalReceipt,
  loadProject,
  runValidation,
  trapScan,
  writeJsonArtifact,
} from '../index.mjs';
import { createBudgetLimitMiddleware } from '../middleware/budget-limit.mjs';
import { createGuardCoreMiddleware } from '../middleware/guard-core.mjs';
import { createObservabilityMiddleware } from '../middleware/observability.mjs';
import { createPolicyGateMiddleware } from '../middleware/policy-gate.mjs';
import { createReceiptWriterMiddleware } from '../middleware/receipt-writer.mjs';
import { createRetryPolicyMiddleware } from '../middleware/retry-policy.mjs';
import { createTrapShieldMiddleware } from '../middleware/trap-shield.mjs';
import { MiddlewareRegistry, runMiddlewareHook } from './middleware-registry.mjs';
import { loadProfile } from './profiles.mjs';
import {
  appendRunEvent,
  completeRunState,
  createRunState,
  relativeArtifactPath,
  writeRunArtifact,
  writeRunState,
} from './state.mjs';
import { probeRuntime } from './runtime-probe.mjs';

export async function executeHarnessRun({
  dir = process.cwd(),
  profile = 'local_no_spend',
  task = null,
  probe_runtime = null,
  probe_contract = 'generic-local-http',
  proposed_actions = [],
  extra_middleware = [],
} = {}) {
  const project = await loadProject(dir);
  const resolvedProfile = await loadProfile(profile);
  const runTask = task || project.agent?.primary_goal || 'local harness proof';
  const state = await createRunState({
    dir,
    profile: resolvedProfile.id,
    task: runTask,
    project_paths: {
      root: path.resolve(dir),
      agent: relativeArtifactPath(dir, project.agent_path),
      policy: relativeArtifactPath(dir, project.policy_path),
    },
  });
  const middleware = [
    ...defaultMiddlewareRegistry().resolve(resolvedProfile.middleware),
    ...(Array.isArray(extra_middleware) ? extra_middleware : []),
  ];
  const context = {
    dir,
    project,
    profile: resolvedProfile,
    state,
    middleware,
    options: { proposed_actions },
    blocked: false,
    block_reason: null,
    emit: (event) => appendRunEvent(dir, state, event),
  };

  try {
    await context.emit({
      type: 'before_agent',
      severity: 'info',
      summary: 'Harness run started.',
      data: { profile: resolvedProfile.id, task: runTask },
    });

    for (const hook of ['before_agent', 'before_policy', 'after_policy', 'before_tool']) {
      const blockedRun = await dispatchBlockingHook(context, hook);
      if (blockedRun) return blockedRun;
    }

    context.proof = createLocalProof(project);
    context.receipt = createLocalReceipt(project, context.proof);
    if (context.proof.status === 'blocked') {
      context.blocked = true;
      context.block_reason = 'local_proof_blocked';
      return await finishBlockedRun(context);
    }

    const beforeReceipt = await runMiddlewareHook(middleware, 'before_receipt', context);
    if (beforeReceipt.blocked) return await finishBlockedRun(context);
    const afterReceipt = await runMiddlewareHook(middleware, 'after_receipt', context);
    if (afterReceipt.blocked) return await finishBlockedRun(context);

    if (probe_runtime) {
      const probe = await probeRuntime({
        dir,
        url: probe_runtime,
        contract: probe_contract,
        runState: state,
      });
      if (probe.artifact.status === 'blocked') {
        context.blocked = true;
        context.block_reason = 'runtime_probe_blocked';
        return await finishBlockedRun(context);
      }
      context.runtime_probe = probe.artifact;
      context.runtime_probe_path = relativeArtifactPath(dir, probe.path);
    }

    const afterToolBlock = await dispatchBlockingHook(context, 'after_tool');
    if (afterToolBlock) return afterToolBlock;

    await context.emit({
      type: 'before_export',
      severity: 'info',
      summary: 'Preparing run-scoped Agent OS Harness export.',
      data: { artifact: 'agent-os-harness.json' },
    });
    const beforeExportBlock = await dispatchBlockingHook(context, 'before_export');
    if (beforeExportBlock) return beforeExportBlock;

    const exportPacket = buildAgentOsExport(project);
    const exportPath = await writeRunArtifact(dir, state, 'agent-os-harness.json', exportPacket);
    context.export_packet = exportPacket;
    context.export_path = relativeArtifactPath(dir, exportPath);
    await context.emit({
      type: 'after_export',
      severity: 'info',
      summary: 'Run-scoped Agent OS Harness export completed.',
      data: { path: context.export_path },
    });
    const afterExportBlock = await dispatchBlockingHook(context, 'after_export');
    if (afterExportBlock) return afterExportBlock;

    await context.emit({
      type: 'artifact_written',
      severity: 'info',
      summary: 'Run-scoped Agent OS Harness export written.',
      data: { path: context.export_path },
    });
    const artifactBlock = await dispatchBlockingHook(context, 'artifact_written');
    if (artifactBlock) return artifactBlock;

    const afterAgentBlock = await dispatchBlockingHook(context, 'after_agent');
    if (afterAgentBlock) return afterAgentBlock;

    await completeRunState(dir, state, 'passed');
    await runMiddlewareHook(middleware, 'run_completed', context);
    await writeRunState(dir, state);
    return {
      ok: true,
      status: 'passed',
      run_id: state.run_id,
      run_path: `.agoragentic/runs/${state.run_id}`,
      state,
      proof: context.proof,
      receipt: context.receipt,
    };
  } catch (error) {
    context.blocked = true;
    context.block_reason = error.message || 'run_failed';
    await context.emit({
      type: 'run_blocked',
      severity: 'error',
      summary: 'Harness run failed.',
      data: { error: error.message },
    });
    await completeRunState(dir, state, 'failed');
    await runMiddlewareHook(middleware, 'run_blocked', context);
    return {
      ok: false,
      status: 'failed',
      run_id: state.run_id,
      run_path: `.agoragentic/runs/${state.run_id}`,
      error: error.message,
      state,
    };
  }
}

export async function executeRuntimeProbeRun({
  dir = process.cwd(),
  url,
  contract = 'agoragentic-rust-http',
} = {}) {
  const profile = await loadProfile('runtime_probe_only');
  const state = await createRunState({
    dir,
    profile: profile.id,
    task: `runtime probe ${url}`,
    project_paths: { root: path.resolve(dir) },
  });
  const context = {
    dir,
    profile,
    state,
    block_reason: null,
    emit: (event) => appendRunEvent(dir, state, event),
  };
  const middleware = defaultMiddlewareRegistry().resolve(profile.middleware);
  try {
    const probe = await probeRuntime({ dir, url, contract, runState: state });
    const status = probe.artifact.status === 'blocked' ? 'blocked' : 'passed';
    await completeRunState(dir, state, status);
    if (status === 'blocked') {
      context.block_reason = 'runtime_probe_blocked';
      await runMiddlewareHook(middleware, 'run_blocked', context);
    } else {
      await runMiddlewareHook(middleware, 'run_completed', context);
    }
    return {
      ok: status === 'passed',
      status,
      run_id: state.run_id,
      run_path: `.agoragentic/runs/${state.run_id}`,
      probe_path: relativeArtifactPath(dir, probe.path),
      probe: probe.artifact,
      state,
    };
  } catch (error) {
    context.block_reason = error.message;
    await appendRunEvent(dir, state, {
      type: 'run_blocked',
      severity: 'blocked',
      summary: 'Runtime probe rejected before network access.',
      data: { error: error.message },
    });
    await completeRunState(dir, state, 'blocked');
    await runMiddlewareHook(middleware, 'run_blocked', context);
    return {
      ok: false,
      status: 'blocked',
      run_id: state.run_id,
      run_path: `.agoragentic/runs/${state.run_id}`,
      error: error.message,
      state,
    };
  }
}

export function defaultMiddlewareRegistry() {
  return new MiddlewareRegistry([
    createPolicyGateMiddleware({ runValidation }),
    createTrapShieldMiddleware({ trapScan }),
    createGuardCoreMiddleware(),
    createBudgetLimitMiddleware(),
    createRetryPolicyMiddleware(),
    createReceiptWriterMiddleware({ createLocalProof, createLocalReceipt, writeJsonArtifact }),
    createObservabilityMiddleware(),
  ]);
}

async function dispatchBlockingHook(context, hook) {
  const result = await runMiddlewareHook(context.middleware, hook, context);
  return result.blocked ? finishBlockedRun(context) : null;
}

async function finishBlockedRun(context) {
  await completeRunState(context.dir, context.state, 'blocked');
  const middleware = context.middleware
    || defaultMiddlewareRegistry().resolve(context.profile.middleware);
  await runMiddlewareHook(middleware, 'run_blocked', context);
  await writeRunState(context.dir, context.state);
  return {
    ok: false,
    status: 'blocked',
    run_id: context.state.run_id,
    run_path: `.agoragentic/runs/${context.state.run_id}`,
    error: context.block_reason || 'blocked',
    state: context.state,
  };
}
