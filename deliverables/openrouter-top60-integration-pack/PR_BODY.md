## Summary

Adds a source-packaged, review-only OpenRouter top-60 integration pack under `deliverables/`. It is not published as an installable Agoragentic runtime integration and is not activated.

The ranking mixes MCP hosts, coding agents, model gateways, remote services, plugin ecosystems, closed consumer apps, ambiguous products, and retired targets. This PR accounts for all 60 while avoiding unsupported active-manifest claims. The user-supplied ranking screenshots are not preserved in this PR, so rank/token transcription remains non-reproducible from repository contents.

### Included

- 60-entry machine-readable audit;
- 12 host assessments with status `blocked_pending_qualified_host_enforcement`;
- OpenRouter Agent SDK tools with `requireApproval: true` plus a hard caller-bound `max_cost` or `quote_id` ceiling on execute;
- Codebuff tools that intentionally omit execute;
- corrected task quote/match and commerce receipt routes;
- fail-closed Oration client with normalized API base paths, exact conversation types, and creation, telephony, and DND gates;
- consolidated composition/provider/plugin/vendor/blocked/deprecated decisions;
- hermetic machine-surface validator plus semantic/adversarial tests.

There is no current Agoragentic MCP relay configuration in this pack. The registry relay is legacy and must not be used; this source-packaged review artifact is not published as an installable runtime integration; and remote MCP work awaits a separately qualified host-enforcement boundary. Hosts that can embed code may instead use the supported SDK or REST match path.

## Validation

```text
npm ci --ignore-scripts --prefix deliverables/openrouter-top60-integration-pack
npm --prefix deliverables/openrouter-top60-integration-pack run check
npm --prefix deliverables/openrouter-top60-integration-pack test
npm --prefix deliverables/openrouter-top60-integration-pack run typecheck
node --test test/mcp-direct-bypass.test.mjs
```

The check command covers the pack validator, JavaScript syntax checks, and Codebuff TypeScript validation; the pack test command discovers the Node semantic/adversarial suite without embedding a stale pass count in this body. The final command runs from the repository root and rejects direct Agoragentic MCP bypass artifacts. These checks cover internal pack boundaries and cross-record consistency, not screenshot reproduction or external runtime compatibility. SDK, REST, and adapter candidates remain unverified and unauthorized. External dependency installation and an owner-approved no-spend host run are required before their catalog promotion; the 12 MCP-host assessments additionally remain blocked until a separately qualified host-enforcement boundary exists.

Dependency-audit note (2026-09-01): the lockfile constrains `@ai-sdk/provider-utils@3` to the patched `undici@6.28.0` floor, removing the eight tracked undici advisories from this development-only graph. `npm audit` still reports five low-severity, non-undici dependency packages beneath the pinned `@codebuff/sdk@0.10.7` validation dependency. The registry's automatic remediation is a Codebuff SDK downgrade, so this review pack does not apply that unverified compatibility change. Nothing in this PR is published as a runtime package; promotion remains blocked pending an upstream-clean dependency set or an explicit owner risk decision.
