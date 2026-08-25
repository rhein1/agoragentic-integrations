## Summary

Adds a review-only OpenRouter top-60 integration pack under `deliverables/`.

The ranking mixes MCP hosts, coding agents, model gateways, remote services, plugin ecosystems, closed consumer apps, ambiguous products, and retired targets. This PR accounts for all 60 while avoiding unsupported active-manifest claims. The user-supplied ranking screenshots are not preserved in this PR, so rank/token transcription remains non-reproducible from repository contents.

### Included

- 60-entry machine-readable audit;
- 12 candidate MCP-host configurations;
- OpenRouter Agent SDK tools with `requireApproval: true` plus a hard caller-bound `max_cost` or `quote_id` ceiling on execute;
- Codebuff tools that intentionally omit execute;
- corrected task quote/match and commerce receipt routes;
- fail-closed Oration client with normalized API base paths, exact conversation types, and creation, telephony, and DND gates;
- consolidated composition/provider/plugin/vendor/blocked/deprecated decisions;
- hermetic machine-surface validator plus semantic/adversarial tests.

## Validation

```text
npm ci --ignore-scripts --prefix deliverables/openrouter-top60-integration-pack
npm --prefix deliverables/openrouter-top60-integration-pack run check
npm --prefix deliverables/openrouter-top60-integration-pack test
npm --prefix deliverables/openrouter-top60-integration-pack run typecheck
```

The check command covers the pack validator, JavaScript syntax checks, and Codebuff TypeScript validation; the test command discovers the Node semantic/adversarial suite without embedding a stale pass count in this body. These checks cover internal pack boundaries and cross-record consistency, not screenshot reproduction or external runtime compatibility. All candidates remain unverified and unauthorized. External dependency installation and an owner-approved no-spend host run are required before catalog promotion.

Dependency-audit note (2026-08-25): `npm audit` reports six vulnerable dependency packages (4 low, 1 moderate, 1 high) beneath the pinned, development-only `@codebuff/sdk@0.10.7` validation dependency. The registry's automatic remediation is a Codebuff SDK downgrade, so this review pack does not apply that unverified compatibility change. Nothing in this PR is published as a runtime package; promotion remains blocked pending an upstream-clean dependency set or an explicit owner risk decision.
