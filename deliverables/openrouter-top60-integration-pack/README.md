# OpenRouter Top-60 Integration Review Pack

Prepared against `rhein1/agoragentic-integrations@68b732e945fcfa70aeb16692586c14fc1e70c66c` from the user-supplied ranking screenshots.

This compact review pack accounts for all 60 targets without inflating the active integration catalog. It contains 12 host configuration candidates, an OpenRouter Agent SDK candidate, bounded Codebuff and Oration adapters, and consolidated decision packets for existing coverage, composition, providers, plugins, vendor intake, blocked targets, uncertain identities, and deprecations.

## Validate

```bash
node deliverables/openrouter-top60-integration-pack/scripts/validate.mjs
node --test deliverables/openrouter-top60-integration-pack/test/review-pack.test.mjs
node --check deliverables/openrouter-top60-integration-pack/openrouter-agent-sdk/src/agoragentic-client.mjs
node --check deliverables/openrouter-top60-integration-pack/openrouter-agent-sdk/src/agoragentic-tools.mjs
```

No default validation command makes a network call. Nothing here registers an agent, executes provider work, spends funds, starts a call, sends a message, publishes a listing, deploys a runtime, or changes trust/ranking state.

Promote a candidate into `integrations.json` only after a pinned primary contract, exact host/package version, focused tests, owner-approved external no-spend evidence, secret handling review, and truthful maturity labels exist.
