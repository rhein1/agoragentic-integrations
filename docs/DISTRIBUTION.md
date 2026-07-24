# Client-Native Distribution

This file tracks repository readiness separately from external listing state. A package can be ready without being submitted, approved, listed, or active.

The canonical machine packet is [`catalog-profile.json`](./catalog-profile.json).

## Current Package Surfaces

| Client | Local/direct package | External discovery state |
|---|---|---|
| Cursor | [`.cursor-plugin/plugin.json`](../.cursor-plugin/plugin.json) | Ready for publisher submission; no submission receipt or Marketplace listing is confirmed |
| Gemini CLI | [`gemini-extension.json`](../gemini-extension.json) | Direct Git install ready and repository topic present; gallery indexing is not confirmed |
| Claude Code | [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) | Self-hosted community marketplace; no Anthropic listing claim |
| Cline | [`llms-install.md`](../llms-install.md) | [Submission issue #808](https://github.com/cline/mcp-marketplace/issues/808) is open and pending Cline review |
| Docker MCP Catalog | [`Dockerfile`](../Dockerfile) | [Registry PR #4524](https://github.com/docker/mcp-registry/pull/4524) is open and pending Docker review |

Every default client package launches the published MCP relay without embedding `AGORAGENTIC_API_KEY`. Tool inventory is dynamic and authentication-dependent. Do not publish a static tool count in directory copy.

## Existing MCP Discovery

The npm package, Official MCP Registry entry, Smithery listing, Glama listing, PulseMCP listing, and community awesome-list entry are established distribution surfaces.

The Smithery listing metadata is current. Its usage dashboard counts initialization and listability sessions separately from tool calls, so session totals must not be presented as evidence of capability use. The latest owner review found discovery/probe traffic but no recorded tool invocations.

The owned `mcp.so` listing still carries stale copy and has more than one historical slug. The editor accepted changes but did not persist them, and the site's ticket form did not create a visible record. A support email was sent on 2026-07-23; no repair or consolidation is confirmed.

## OpenAI / ChatGPT Boundary

Do not submit the existing commerce MCP surface to the OpenAI public plugin directory. Current OpenAI app rules allow commerce only for physical goods and prohibit execution of crypto transfers. A future OpenAI submission would need a separately deployed, purpose-specific surface that is eligible under the then-current rules; a label such as "read only" is not enough if the app still promotes or enables prohibited digital-service commerce.

The existing OpenAI Agents SDK adapters in this repository remain open-source framework integrations. They are not ChatGPT App Directory listings.

## Outstanding Distribution Work

1. Complete the Cursor publisher application and retain a submission receipt; stop for owner terms acceptance.
2. Wait for or respond to Cline review on [issue #808](https://github.com/cline/mcp-marketplace/issues/808).
3. Wait for or respond to Docker review on [PR #4524](https://github.com/docker/mcp-registry/pull/4524).
4. Follow up with `mcp.so` support until the owned listing persists current metadata and duplicate records are consolidated.
5. Confirm Gemini CLI gallery indexing separately from direct-install and repository-topic readiness.

External status must be updated only after the corresponding service confirms submission or listing.
