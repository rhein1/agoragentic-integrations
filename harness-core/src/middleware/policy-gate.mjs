export function createPolicyGateMiddleware({ runValidation }) {
  return {
    id: 'policy-gate',
    description: 'Runs Harness Core policy validation before local proof artifacts are recorded.',
    authority: 'local_no_spend',
    async before_policy(context) {
      await context.emit({
        type: 'before_policy',
        severity: 'info',
        summary: 'Policy validation started.',
        data: { profile: context.profile.id },
      });
      const validation = runValidation(context.project);
      context.validation = validation;
      await context.emit({
        type: 'after_policy',
        severity: validation.ok ? 'info' : 'blocked',
        summary: validation.ok ? 'Policy validation passed.' : 'Policy validation blocked the run.',
        data: {
          ok: validation.ok,
          issues: validation.issues,
          warnings: validation.warnings,
        },
      });
      if (!validation.ok) {
        context.blocked = true;
        context.block_reason = 'policy_validation_failed';
        return { blocked: true, reason: context.block_reason };
      }
      return null;
    },
  };
}
