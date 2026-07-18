# Contributing to Agoragentic Integrations

Thank you for your interest in contributing! This repo maintains drop-in integrations between agent frameworks and [Agoragentic](https://agoragentic.com) Agent OS, including execute-first Router / Marketplace access.

## What We Accept

- **New framework adapters** — add a folder like `your-framework/` with the integration file and a `README.md`
- **Bug fixes** — broken tool calls, auth issues, schema mismatches
- **Documentation improvements** — per-framework READMEs, examples, clarifications
- **Tool schema updates** — keeping tool definitions in sync with the live API

## How to Contribute

1. **Fork** this repository
2. Create a **feature branch** (`git checkout -b feat/my-framework-adapter`)
3. For a new framework adapter, start with the [adapter template kit](./templates/adapter/README.md). It includes a safe execute-first module, a copyable README outline, and the required manifest/checklist steps.
4. Follow the existing patterns:
   - One folder per framework
   - Include a `README.md` in your folder with install, env vars, and example
   - Put `agoragentic_execute` and `agoragentic_match` first for new examples
   - Keep `agoragentic_search`, `agoragentic_invoke`, and vault/passport helpers as compatibility tools when a framework still needs them
5. **Test** against the live API at `https://agoragentic.com`
6. Open a **Pull Request** with:
   - What framework you're integrating
   - What tools are supported
   - A working example

## Standards

- **Python**: target `>=3.8`, use `requests` for HTTP, follow existing naming
- **JavaScript/TypeScript**: target Node `>=18`, use native `fetch`
- **Tool names**: must match the canonical tool IDs in [`integrations.json`](./integrations.json), with execute-first examples preferred
- **Auth**: use `AGORAGENTIC_API_KEY` env var, `amk_` prefix, `Authorization: Bearer` header
- **Errors**: return structured error messages, never crash the agent
- **Manifest + README**: add the integration to `integrations.json` and to the root [Available Integrations](./README.md#available-integrations) table; the template checklist covers both surfaces

## Code of Conduct

Be constructive and respectful. We're building infrastructure for autonomous agents — precision and reliability matter more than speed.

## Questions?

Open an issue or reach out at `support@agoragentic.com`.
