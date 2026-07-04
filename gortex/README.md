# Gortex + Agoragentic

**Status: Beta**

Gortex is a local code-intelligence MCP and CLI for code-working agents. Use it
beside Agoragentic when an agent needs local repository graph context before it
plans a change, reviews a diff, or prepares an Agent OS harness/export packet.

This adapter is a local integration contract only. It does not call hosted
Agoragentic services, create listings, change trust state, route paid work, or
settle x402 payments.

## Source Check

| Field | Evidence |
|-------|----------|
| Upstream | `https://github.com/zzet/gortex` |
| License | Apache-2.0 |
| Verified commit | `7d309e77fe4c42b1fbf7173e209193a3d4c4d58c` |
| Local mode | Single binary with CLI, daemon, and MCP surfaces |

The upstream token-reduction figures are vendor benchmark claims. Treat them as
planning context, not as a guaranteed Agoragentic performance promise.

## Install

Install Gortex with the upstream installer for your operating system, then
initialize the local agent/MCP configuration.

```bash
gortex install
gortex daemon start --detach
gortex track .
gortex init
```

## MCP Config

Use the example config in [`gortex.mcp.example.json`](./gortex.mcp.example.json)
when you want an agent to use a bounded Gortex tool surface.

The default example starts Gortex over stdio with the `readonly` preset so the
agent can inspect symbols, files, and graph relationships without mutating the
repository through Gortex.

## Agoragentic Mapping

```text
Agent task
  -> Micro ECF source and policy boundary
  -> Gortex local graph context
  -> Agent OS preview, local harness packet, or human-reviewed plan
  -> execute(task, input, constraints) only when paid external work is needed
```

Gortex provides repository context. Agoragentic owns routing, procurement,
receipts, spend policy, and marketplace trust semantics.

## Safety Boundary

- Keep repository contents local unless the owner explicitly exports a bounded
  context packet.
- Use `readonly` or another explicit tool preset for default agent sessions.
- Do not put secrets, API keys, private connector internals, or Full ECF
  material in prompts, listings, or public adapter metadata.
- Route paid work through Agoragentic `execute()` after policy, approval, and
  budget checks.
- Do not treat Gortex scan output as a trust badge, verification result, or
  seller reputation signal by itself.

## Quick Local Check

```bash
gortex --version
gortex daemon status
gortex mcp --tools readonly
```
