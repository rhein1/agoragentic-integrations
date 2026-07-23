import { evaluateGuardAction } from '../vendor/guard-core.mjs';
import { createApprovalRequest } from '../kernel/approvals.mjs';

export function createGuardCoreMiddleware() {
  return {
    id: 'guard-core',
    description: 'Evaluates proposed high-risk actions through Guard Core and records approval requests without executing actions.',
    authority: 'local_no_spend',
    async before_tool(context) {
      const actions = normalizeProposedActions(context.project.policy?.proposed_actions || context.options?.proposed_actions || []);
      if (!actions.length) return null;
      const policy = context.project.policy?.guard_policy || context.project.policy?.wallet_action_policy || null;
      for (const action of actions) {
        const decision = evaluateGuardAction(policy, action);
        context.guard_decisions = [...(context.guard_decisions || []), decision];
        const event = await context.emit({
          type: 'guard_decision',
          severity: decision.verdict === 'deny' ? 'blocked' : decision.verdict === 'needs_approval' ? 'warning' : 'info',
          summary: `Guard Core decision: ${decision.verdict}.`,
          data: { decision, action },
        });
        if (decision.verdict === 'needs_approval') {
          const approval = await createApprovalRequest({
            dir: context.dir,
            run_id: context.state.run_id,
            requested_action: action,
            risk_class: decision.risk_level,
            reason: decision.reasons.map((entry) => entry.code).join(', ') || 'guard_core_needs_approval',
            required_approvals: decision.required_approvals,
            source_event_id: event.event_id,
            guard_decision_id: decision.decision_id,
          });
          context.approvals = [...(context.approvals || []), approval];
          await context.emit({
            type: 'approval_required',
            severity: 'warning',
            summary: 'Approval request recorded for Guard Core decision.',
            data: { approval },
          });
        }
        if (decision.verdict === 'deny') {
          context.blocked = true;
          context.block_reason = 'guard_core_denied_action';
          return { blocked: true, reason: context.block_reason };
        }
      }
      return null;
    },
  };
}

function normalizeProposedActions(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry && typeof entry === 'object');
}
