# Client-Native Distribution

This file tracks repository readiness separately from external listing state. A package can be ready without being submitted, approved, listed, or active.

The canonical machine packet is [`catalog-profile.json`](./catalog-profile.json).

## Current Package Surfaces

| Client | Local/direct package | External discovery state |
|---|---|---|
| Cursor | [`.cursor-plugin/plugin.json`](../.cursor-plugin/plugin.json) | Ready for owner submission; not yet a Marketplace listing |
| Gemini CLI | [`gemini-extension.json`](../gemini-extension.json) | Direct Git install ready; gallery requires the repository topic and crawler |
| Claude Code | [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) | Self-hosted community marketplace; no Anthropic listing claim |
| Cline | [`llms-install.md`](../llms-install.md) | Ready for a Cline Marketplace submission issue |
| Docker MCP Catalog | [`Dockerfile`](../Dockerfile) | Existing image source is ready; upstream entry should pin the merged commit |

Every default client package launches the published MCP relay without embedding `AGORAGENTIC_API_KEY`. Tool inventory is dynamic and authentication-dependent. Do not publish a static tool count in directory copy.

## Existing MCP Discovery

The npm package, Official MCP Registry entry, Smithery listing, Glama listing, PulseMCP listing, and community awesome-list entry are established distribution surfaces. Smithery still presents an old static tool count and marketplace-first description. `mcp.so` carries materially stale copy and has more than one historical slug. Both require directory-side metadata updates; the repository packet is ready, but it cannot rewrite those third-party records.

## OpenAI / ChatGPT Boundary

Do not submit the existing commerce MCP surface to the OpenAI public plugin directory. Current OpenAI app rules allow commerce only for physical goods and prohibit execution of crypto transfers. A future OpenAI submission would need a separately deployed, purpose-specific surface that is eligible under the then-current rules; a label such as "read only" is not enough if the app still promotes or enables prohibited digital-service commerce.

The existing OpenAI Agents SDK adapters in this repository remain open-source framework integrations. They are not ChatGPT App Directory listings.

## Submission Order

1. Merge and validate the native package manifests.
2. Add the `gemini-cli-extension`, `cursor-plugin`, and `claude-code-plugin` repository topics.
3. Submit Cursor through the publisher portal; stop for owner identity or terms acceptance.
4. Open the Cline Marketplace submission issue using the 400 by 400 icon and `llms-install.md`.
5. Open a Docker MCP Registry PR pinned to the merged source commit.
6. Claim and consolidate the duplicate `mcp.so` records.

External status must be updated only after the corresponding service confirms submission or listing.
