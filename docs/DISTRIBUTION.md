# Client-Native Distribution

This file tracks repository artifacts separately from external listing state and runtime qualification. A package or listing can exist without being safe, operational, approved, or active.

The canonical machine packet is [`catalog-profile.json`](./catalog-profile.json).

## Current Package Surfaces

| Client | Local/direct package | External discovery state |
|---|---|---|
| Cursor | [`.cursor-plugin/plugin.json`](../.cursor-plugin/plugin.json) | Metadata retained; remote MCP disabled pending qualified host enforcement |
| Gemini CLI | [`gemini-extension.json`](../gemini-extension.json) | Metadata retained; remote MCP disabled; gallery indexing is not runtime evidence |
| Claude Code | [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) | Self-hosted metadata retained; remote MCP disabled; no Anthropic listing claim |
| Cline | [`llms-install.md`](../llms-install.md) | Legacy direct-relay [submission issue #808](https://github.com/cline/mcp-marketplace/issues/808) requires withdrawal or correction; no current registry install is supported |
| Docker MCP Catalog | [`Dockerfile`](../Dockerfile) | Legacy direct-relay [registry PR #4524](https://github.com/docker/mcp-registry/pull/4524) requires withdrawal or correction before review |

No default client package launches a live Agoragentic relay. The fail-closed 2.0.0 build exists only as an unpublished, non-installable source candidate. The npm name still resolves a legacy direct relay and must not be installed or launched. Never embed `AGORAGENTIC_API_KEY`. Do not publish a static tool count in directory copy.

## Existing MCP Discovery

The npm package, Official MCP Registry entry, Smithery listing, Glama listing, PulseMCP listing, and community awesome-list entry are legacy direct-relay distribution records. Each requires correction or withdrawal; none points to a current installable fail-closed build, proves hosted Risk Fork interception, or qualifies live containment.

The Smithery record is not current build metadata. Its usage dashboard counts initialization and listability sessions separately from tool calls, so session totals must not be presented as evidence of capability use. The latest owner review found discovery/probe traffic but no recorded tool invocations.

The owned `mcp.so` listing still carries stale copy and has more than one historical slug. The editor accepted changes but did not persist them, and the site's ticket form did not create a visible record. A support email was sent on 2026-07-23; no repair or consolidation is confirmed.

## OpenAI / ChatGPT Boundary

Do not submit the existing commerce MCP surface to the OpenAI public plugin directory. Current OpenAI app rules allow commerce only for physical goods and prohibit execution of crypto transfers. A future OpenAI submission would need a separately deployed, purpose-specific surface that is eligible under the then-current rules; a label such as "read only" is not enough if the app still promotes or enables prohibited digital-service commerce.

The existing OpenAI Agents SDK adapters in this repository remain open-source framework integrations. They are not ChatGPT App Directory listings.

## Documentation And Industry Maps

| Surface | Prepared artifact | External state |
|---|---|---|
| Context Hub | [`distribution/context-hub/`](../distribution/context-hub/) | Maintainer documentation is prepared and validated locally; no upstream submission has been made |
| Agent Payments Stack | [`correction.json`](../distribution/agent-payments-stack/correction.json) | The live record needs a metadata refresh; the correction packet is prepared but not submitted |

Both packets use live machine endpoints as authority instead of freezing inventory or availability claims into directory copy. They do not grant credentials, spend authority, wallet authority, deployment authority, or permission to publish externally.

## Outstanding Distribution Work

1. Keep all MCP client listings non-operational until hosted interception and qualified host evidence satisfy issue #301.
2. Withdraw or correct every legacy direct-relay record only with explicit owner authorization and retain each submission receipt.
3. Treat npm, the Official MCP Registry, Cursor, Cline, Docker, Gemini, Smithery, Glama, PulseMCP, and community-directory presence as stale metadata only.
4. Follow up with `mcp.so` support only after the owner approves the corrected non-operational copy.
5. Review the Context Hub packet, then submit it upstream only with explicit owner authorization.
6. Review and submit the Agent Payments Stack correction only with explicit owner authorization; retain the submission receipt.

External status must be updated only after the corresponding service confirms submission or listing.
