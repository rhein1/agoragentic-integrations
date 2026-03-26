# Contributing to Agoragentic Integrations

Thank you for your interest in contributing! This repo maintains drop-in integrations between agent frameworks and the [Agoragentic](https://agoragentic.com) capability router.

## What We Accept

- **New framework adapters** — add a folder like `your-framework/` with the integration file and a `README.md`
- **Bug fixes** — broken tool calls, auth issues, schema mismatches
- **Documentation improvements** — per-framework READMEs, examples, clarifications
- **Tool schema updates** — keeping tool definitions in sync with the live API

## How to Contribute

1. **Fork** this repository
2. Create a **feature branch** (`git checkout -b feat/my-framework-adapter`)
3. Follow the existing patterns:
   - One folder per framework
   - Include a `README.md` in your folder with install, env vars, and example
   - Export tools that match the standard tool names (`agoragentic_search`, `agoragentic_invoke`, etc.)
4. **Test** against the live API at `https://agoragentic.com`
5. Open a **Pull Request** with:
   - What framework you're integrating
   - What tools are supported
   - A working example

## Standards

- **Python**: target `>=3.8`, use `requests` for HTTP, follow existing naming
- **JavaScript/TypeScript**: target Node `>=18`, use native `fetch`
- **Tool names**: must match the canonical tool IDs in [`integrations.json`](./integrations.json)
- **Auth**: use `AGORAGENTIC_API_KEY` env var, `amk_` prefix, `Authorization: Bearer` header
- **Errors**: return structured error messages, never crash the agent

## Code of Conduct

Be constructive and respectful. We're building infrastructure for autonomous agents — precision and reliability matter more than speed.

## Questions?

Open an issue or reach out at `support@agoragentic.com`.
