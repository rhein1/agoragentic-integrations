import { scanSourceText } from '../vendor/guard-core.mjs';

export function createTrapShieldMiddleware({ trapScan }) {
  return {
    id: 'trap-shield',
    description: 'Blocks prompt injection, secret exfiltration, policy override, and unauthorized spend text before proof.',
    authority: 'local_no_spend',
    async before_agent(context) {
      await context.emit({
        type: 'before_agent',
        severity: 'info',
        summary: 'Trap Shield scan started.',
        data: { profile: context.profile.id },
      });
      const text = [
        context.project.agent?.primary_goal,
        context.project.agent?.description,
        ...(context.project.policy?.tool_policy?.allowed_tools || []),
      ].filter(Boolean).join('\n');
      const harnessScan = trapScan(text);
      const guardScan = scanSourceText(text);
      const blocked = harnessScan.blocked || guardScan.findings.some((entry) => entry.severity === 'critical');
      context.trap_scan = { harness: harnessScan, guard: guardScan, blocked };
      await context.emit({
        type: 'after_agent',
        severity: blocked ? 'blocked' : 'info',
        summary: blocked ? 'Trap Shield blocked unsafe content.' : 'Trap Shield scan passed.',
        data: context.trap_scan,
      });
      if (blocked) {
        context.blocked = true;
        context.block_reason = 'trap_shield_blocked';
        return { blocked: true, reason: context.block_reason };
      }
      return null;
    },
  };
}
