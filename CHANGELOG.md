# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Added client-native packages for Cursor, Gemini CLI, Claude Code, and Cline, all using the published MCP relay without embedding an API key.
- Added a canonical distribution packet, external-channel status matrix, 400 by 400 plugin icon, and repository-owned validation for package metadata and no-spend boundaries.
- Added the Harness Core 0.2.0 public-source candidate: middleware lifecycle, append-only run ledgers, local approvals and maker-checker review records, profiles, loopback runtime probes, refs-only context imports, owner inbox/status, schedule intent, worktree-session evidence, all public schemas, and framework-wrapping examples.
- Added experimental documentation paths for Langflow, Browser Use, DSPy, AgentScope, VoltAgent, and Genkit. These entries do not claim tested package or runtime support.
- Added beta, framework-native adapters for Griptape, LiveKit Agents, and Pipecat with hermetic contract tests and current-framework construction evidence.
- Added a status-safe 1280x640 integrations banner and first-viewport discovery copy.

### Changed
- Superseded `agoragentic-mcp@1.3.5` with `1.3.6` after a clean downstream install proved npm does not propagate dependency-level overrides. The 1.3.6 package bundles the audited MCP SDK/Hono tree into a Node.js 20 CLI with zero runtime dependencies and adds a packed-consumer install, audit, and MCP fallback smoke gate; all client-native manifests and MCP registry metadata now target the corrected package.
- Bumped the canonical manifest to `2.29.0` with 97 indexed surfaces and added machine discovery pointers for the native client packages.
- Replaced the stale quickstart free-balance example with the bounded API-key response shape and synchronized the social banner count.
- Recorded the current OpenAI public-plugin policy blocker instead of presenting the commerce MCP surface as submission-ready.
- Prepared the `n8n-nodes-agoragentic` 0.1.3 candidate on stable `@n8n/node-cli` 0.40.3 with a committed lockfile, lint/build prepublish gate, exact release-tag validation, and locked CI installs; npm publication remains review- and trusted-publishing-gated.
- Bumped the canonical manifest to `2.28.0`, added Harness Core package coordinates plus its npm-first install command, and made the package-index schema enumerate every currently declared package family.
- Hardened Harness Core publication with a lockfile, exact version-tag validation, locked installs, and an out-of-repository packed-install/schema-export smoke test. npm publication remains gated on review, merge, the exact `harness-core-v0.2.0` release, and trusted publishing.
- Bumped the canonical manifest to `2.27.0` with 93 indexed integration surfaces.
- Restored 13 existing adapter directories that were missing from `integrations.json`: Dfns, fast-agent, Goose, Haystack, Kibble, LI.FI, MPPScan, Olas, Reown, Safe, Superfluid, Tempo MPP, and u402.
- Updated Agent OS CLI discovery from the stale `1.6.8` pin to `@latest` (currently published as `1.6.9`).
- Published `agoragentic-mcp@1.3.4`, synchronized Glama, and prepared official MCP Registry server record `2.1.3` with the published npm package coordinate.
- Corrected Harness Core publication, Micro ECF canonical-repository, skill URL, paid-price-floor, and live-availability wording across machine-readable discovery.
- Renamed the README table to `Featured Integration Paths`; `integrations.json` is the complete inventory.
- Hardened `agoragentic-mcp@1.3.4` with a lockfile-only install, exact release-tag gate, hermetic keyless-preview tests, package-source metadata, and a high/critical npm audit gate. The known upstream moderate static-file advisory remains documented and is not exercised by the stdio relay.

## [manifest 2.16.0–2.24.2] - 2026-07-03

### Added
- Rolled up the integration-manifest bumps that shipped since `2.15.0`. `integrations.json` is now version `2.24.2` (`updated_at` 2026-07-03). This range covers the discovery/index entries added across many pushes, including but not limited to the `pdf-mcp/` (PDF MCP) and `turbovec/` (TurboVec) integrations, which are present in `integrations.json` and as directories but were previously absent from this changelog.
- Expanded the Interchange protocol package discovery pointers in `integrations.json`.

### Changed
- CHANGELOG version headers from here forward track the integration-manifest version so the manifest and changelog no longer drift silently. Because the manifest version bumps on nearly every push, this entry is phrased as a version range rather than a single hardcoded number.

### Removed
- Removed the Frontier AI hosted-deployment link from `README.md` (originally added in 2.1.0), reconciling the earlier "Added" entry with the current README, which no longer contains it.

## [micro-ecf-v0.1.3] - 2026-06-14

### Changed
- Updated the Micro ECF npm README launch path so the local install command, one-step secret-block proof, and Agent OS handoff boundary are visible from the package page.

## [harness-core-v0.1.0] - 2026-06-04

### Added
- Added `harness-core/`, the package-ready local no-spend Harness Core scaffold for `init`, `validate`, `proof`, `export --to agent-os`, `listing check`, and adapter discovery.
- Added Harness Core schemas, tests, and a Trusted Publishing release workflow gated by `harness-core-v*` release tags.

## [premortem-golden-loop-v0.1.6] - 2026-05-24

### Added
- Added `premortem-golden-loop/`, a free local OSS agent release premortem, no-spend Golden Loop readiness, and safe self-heal scaffold CLI.
- Added Premortem Golden Loop discovery pointers in `integrations.json`, `README.md`, `llms.txt`, `llms-full.txt`, and `SKILL.md`.

## [2.15.0] - 2026-05-19

### Added
- Added `hermes-agent/`, a public Hermes Agent bridge scaffold for Agoragentic MCP tooling, Agent OS handoff manifests, and review-gated self-improvement reflection packets with no live execution authority.
- Added `rust-framework/`, a public Agoragentic Rust Framework HTTP runtime integration folder with TypeScript/Node and Python examples, a self-hosted Agent OS Harness packet example, and no-spend verification.
- Added Rust Framework discovery pointers in `integrations.json`, `README.md`, `llms.txt`, `llms-full.txt`, and `SKILL.md` while keeping hosted Router / Marketplace SDK semantics unchanged.
- Added high-priority adapters for LangGraph, Cloudflare Agents, Microsoft Semantic Kernel, Zapier MCP, Flowise, Composio, and HumanLayer.
- Added an experimental Zoneless payout reference as documentation-only research while keeping Base settlement canonical.
- Folded the integration manifest to version `2.15.0` with all public integration surfaces indexed.
- Added tokenless npm Trusted Publishing workflow and setup notes for `agoragentic-micro-ecf`.

### Changed
- Hardened `agoragentic-mcp` registry builds by committing a package lockfile, adding npm retry defaults, validating the MCP package in CI, and treating registry placeholder API keys as anonymous sessions instead of forwarding invalid bearer tokens.
- Synced the README integration table with all entries in `integrations.json`.
- Added npm repository, homepage, bugs, and public publish metadata for `agoragentic-micro-ecf`.
- Added Micro ECF package tests, syntax checks, and npm pack dry-run to the machine-surface validation workflow.

## [2.6.2] - 2026-04-23

### Added
- **Micro ECF** public repo entrypoint in `micro-ecf/`
  - Local policy example for context, tools, budget, approvals, memory, swarm, and deployment posture
  - No-spend local simulator for checking one proposed task before Agent OS Harness export
  - No-spend `export-agent-os-harness.mjs` helper that emits `agoragentic.agent-os.harness.v1`
  - `agent_os_preview_request` mapping for Agent OS preview without distributing hosted platform internals
- Discovery pointers for the Agent OS Harness at `https://agoragentic.com/agent-os-harness.json`

## [2.5.0] - 2026-04-12

### Added
- **Agent OS Control Plane** public export in `agent-os/`
  - No-spend-by-default Node.js and Python examples for quote, procurement, approvals, and reconciliation
  - Paid `POST /api/execute` gated behind `AGORAGENTIC_EXECUTE=true`
  - Public/private boundary documentation for external agent and developer adoption
- Agent OS discovery pointers in `integrations.json`, `README.md`, `llms.txt`, `llms-full.txt`, and `SKILL.md`
- Explicit Node SDK package metadata in `integrations.json` and `integrations.schema.json`

### Changed
- Synced integration discovery wording to avoid stale hardcoded adapter counts.
- Added the existing LangSmith and oh-my-claudecode adapter directories to the public integration tables/index where missing.

## [2.4.0] - 2026-04-02

### Added
- **Fallback Router SDK** — `require('agoragentic/router')` with `AgoragenticRouter` class
  - Local tools execute first (free), marketplace fallback on missing/failed tools (3% fee)
  - Policy gates: `allowedTasks`, `blockedTasks`, `maxCostPerCall`, `requireQuoteApproval`
- **Settlement Kit** — `require('agoragentic/settle')` with `createPaywall()` Express middleware
  - Sellers verify Agoragentic-managed receipts, 402 response without valid receipt
  - Standalone `verifyReceipt()` for non-Express flows
- **Python SDK Fallback** — `client.fallback(task, input)`, `add_local_tool()`, `has_local_tool()`
- **Base App Adapter Scaffold** — `sdk/base-app/` with preview/execute/quote/status/receipt
- **Monetization Boundary** — explicit docs on where 3% applies (managed execution only)
- SDK v1.4.0 published to npm with `./router` and `./settle` subpath exports
- Integration count: 22 frameworks

## [2.3.0] - 2026-04-02

### Added
- `syrin/` — Syrin agent framework integration (11 marketplace tools + `AgoragenticTools` class)
- Dual-guard spending model documentation (Syrin budget caps + Agoragentic USDC settlement)
- Multi-agent orchestration examples using Syrin `handoff()` and `spawn()` patterns
- Payment-rail metadata in x402 surfaces (`payment_network`, `settlement_network`, `supported_rails`, `normalization_path`)
- Integration count: 22 frameworks

## [2.2.0] - 2026-04-02

### Added
- `langsmith/` — LangSmith observability integration guide (SDK-side + server-side tracing)
- Node.js SDK listed in README packages table (`npm install agoragentic` v1.3.0)
- SDK v1.3.0: optional LangSmith tracing with `langsmith-trace` + `baggage` header propagation
- SDK v1.3.0: sanitized I/O logging (method, path, keys, IDs only — no raw bodies)
- Server-side LangSmith middleware for commerce routes (env-gated, `LANGSMITH_API_KEY`)
- `platform_hosting` metadata now exposed in x402 discovery responses (hosting model transparency)

## [2.1.0] - 2026-03-30

### Added
- `x402/test/echo` — Free $0.00 x402 pipeline test endpoint for validating 402 sign retry flow
- `input_schema` and `output_schema` fields in x402 listing discovery responses
- Per-seller duplicate listing name prevention (409 block) in capabilities API
- Cross-seller name collision warnings (non-blocking) in capabilities API
- Admin duplicate listing report endpoint (`GET /api/admin/listings/duplicates`)
- Frontier AI hosted deployment link in README (community PR #3 by @ElishaKay). _(Later removed — see the manifest 2.16.0–2.24.2 rollup; the link no longer appears in README.md.)_

### Changed
- x402 execute validation error now includes step-by-step two-step flow guide and direct invoke alternative
- Improved 402 payment challenge response with clearer retry instructions

## [2.0.0] - 2026-03-26

### Added
- `integrations.json` — machine-readable index of all 20 integrations
- `integrations.schema.json` — JSON Schema for the index
- `AGENTS.md` — canonical agent instruction file
- `llms.txt` — thin bootstrap for language models
- `llms-full.txt` — expanded context for deep ingestion
- `CITATION.cff` — GitHub citation metadata
- `CONTRIBUTING.md` — contributor guide
- `SECURITY.md` — responsible disclosure policy
- `CODEOWNERS` — per-adapter review ownership
- `.github/ISSUE_TEMPLATE/` — structured bug report + new framework request
- Per-framework `README.md` in 14 integration folders
- CI validation workflow for `integrations.json` and repo structure
- MCP install configs for Claude Desktop, VS Code, Cursor, Windsurf
- Compatibility matrix in README

### Changed
- Root `README.md` rewritten as index — shorter, links to per-folder READMEs
- MCP README expanded with Windsurf config

### Tools (v2.0)
- `agoragentic_register`, `agoragentic_search`, `agoragentic_invoke`
- `agoragentic_vault`, `agoragentic_categories`
- `agoragentic_memory_write`, `agoragentic_memory_read`, `agoragentic_memory_search`
- `agoragentic_learning_queue`, `agoragentic_save_learning_note`
- `agoragentic_secret_store`, `agoragentic_secret_retrieve`
- `agoragentic_passport`

## [1.0.0] - 2026-03-01

### Added
- Initial release with 20 framework integrations
- Python SDK published to PyPI (`agoragentic`)
- MCP server published to npm (`agoragentic-mcp`)
- A2A agent card
- ACP spec v0.1.0
- SKILL.md capability description
- Glama registry entry

<!--
  Only two `vX` tags exist on the remote today: v1.1.0 and v2.1.0. Earlier footer
  links pointed at v1.0.0 / v2.0.0 / v2.2.0, which are not tagged and returned 404.
  Until annotated tags are cut for the remaining releases (see PR "Owner follow-ups"),
  version links point only at refs that resolve: the two real tags, and the main tree.
-->
[Unreleased]: https://github.com/rhein1/agoragentic-integrations/tree/main
[manifest 2.16.0–2.24.2]: https://github.com/rhein1/agoragentic-integrations/tree/main
[micro-ecf-v0.1.3]: https://github.com/rhein1/agoragentic-integrations/releases/tag/micro-ecf-v0.1.3
[harness-core-v0.1.0]: https://github.com/rhein1/agoragentic-integrations/tree/main
[premortem-golden-loop-v0.1.6]: https://github.com/rhein1/agoragentic-integrations/tree/main
[2.15.0]: https://github.com/rhein1/agoragentic-integrations/tree/main
[2.6.2]: https://github.com/rhein1/agoragentic-integrations/tree/main
[2.5.0]: https://github.com/rhein1/agoragentic-integrations/tree/main
[2.4.0]: https://github.com/rhein1/agoragentic-integrations/tree/main
[2.3.0]: https://github.com/rhein1/agoragentic-integrations/tree/main
[2.2.0]: https://github.com/rhein1/agoragentic-integrations/tree/main
[2.1.0]: https://github.com/rhein1/agoragentic-integrations/releases/tag/v2.1.0
[2.0.0]: https://github.com/rhein1/agoragentic-integrations/tree/main
[1.0.0]: https://github.com/rhein1/agoragentic-integrations/releases/tag/v1.1.0
