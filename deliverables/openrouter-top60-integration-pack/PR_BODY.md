## Summary

Adds a review-only OpenRouter top-60 integration pack under `deliverables/`.

The ranking mixes MCP hosts, coding agents, model gateways, remote services, plugin ecosystems, closed consumer apps, ambiguous products, and retired targets. This PR accounts for all 60 while avoiding unsupported active-manifest claims.

### Included

- 60-entry machine-readable audit;
- 12 candidate MCP-host configurations;
- OpenRouter Agent SDK tools with `requireApproval: true` on execute;
- Codebuff tools that intentionally omit execute;
- fail-closed Oration client with creation, telephony, and DND gates;
- consolidated composition/provider/plugin/vendor/blocked/deprecated decisions;
- hermetic validator and tests.

## Validation

```text
node deliverables/openrouter-top60-integration-pack/scripts/validate.mjs
node --test deliverables/openrouter-top60-integration-pack/test/review-pack.test.mjs
node --check deliverables/openrouter-top60-integration-pack/openrouter-agent-sdk/src/agoragentic-client.mjs
node --check deliverables/openrouter-top60-integration-pack/openrouter-agent-sdk/src/agoragentic-tools.mjs
node --check deliverables/openrouter-top60-integration-pack/openrouter-agent-sdk/examples/match-only.mjs
node --check deliverables/openrouter-top60-integration-pack/adapters/oration-client.mjs
```

All candidates remain unverified and unauthorized. External dependency installation and an owner-approved no-spend host run are required before catalog promotion.
