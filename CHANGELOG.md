# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Fronteir AI hosted deployment link in README (community PR #3 by @ElishaKay)

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

[2.2.0]: https://github.com/rhein1/agoragentic-integrations/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/rhein1/agoragentic-integrations/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/rhein1/agoragentic-integrations/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/rhein1/agoragentic-integrations/releases/tag/v1.0.0
