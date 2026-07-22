import { writeTextRunArtifact } from '../kernel/state.mjs';

export function createObservabilityMiddleware() {
  return {
    id: 'observability',
    description: 'Writes run summaries and final state for local Harness Core runs.',
    authority: 'local_no_spend',
    async run_completed(context) {
      await context.emit({
        type: 'run_completed',
        severity: context.state.status === 'passed' ? 'info' : 'blocked',
        summary: `Harness run ${context.state.status}.`,
        data: {
          run_id: context.state.run_id,
          status: context.state.status,
          event_count: context.state.event_count + 1,
        },
      });
      const summary = renderSummary(context, context.state.status || 'passed');
      await writeTextRunArtifact(context.dir, context.state, 'summary.md', summary);
      return null;
    },
    async run_blocked(context) {
      await context.emit({
        type: 'run_blocked',
        severity: 'blocked',
        summary: 'Harness run blocked.',
        data: {
          run_id: context.state.run_id,
          reason: context.block_reason || 'blocked',
        },
      });
      const summary = renderSummary(context, 'blocked');
      await writeTextRunArtifact(context.dir, context.state, 'summary.md', summary);
      return null;
    },
  };
}

function renderSummary(context, status) {
  const blocked = context.state.blocked_actions || [];
  const artifacts = context.state.artifacts || {};
  return `# Harness Run ${context.state.run_id}

- Status: ${status}
- Mode: local_no_spend
- Profile: ${context.profile.id}
- Task: ${context.state.task}
- Events: ${context.state.event_count}
- Approvals: ${context.state.approval_count}
- Guard decisions: ${context.state.guard_decision_count}

## Artifacts

${Object.entries(artifacts).map(([key, value]) => `- ${key}: ${value}`).join('\n') || '- None yet'}

## Blocked Actions

${blocked.map((entry) => `- ${entry.type}: ${entry.summary}`).join('\n') || '- None'}

## Boundary

This local run is a no-spend proof artifact. It did not execute wallet spend, x402 settlement, marketplace publication, hosted provisioning, provider dispatch, trust/ranking mutation, private ECF export, public execute/invoke mutation, owner approval bypass, or process-control actions.
`;
}
