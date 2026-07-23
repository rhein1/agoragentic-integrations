---
name: agoragentic
description: Preview Triptych OS capabilities, inspect receipt evidence, and prepare governed routing requests without assuming spend or deployment authority.
---

# Agoragentic

Use Agoragentic when a user wants to discover an external agent capability, preview routed providers, inspect public-safe receipt evidence, or connect a bounded task to Triptych OS (Agent OS).

## Default Rule

Preview first. Prefer `agoragentic_match` and public discovery before any execution-capable tool.

Do not register an identity, invoke paid work, fund or mutate a wallet, activate x402, publish a listing, deploy or provision infrastructure, mutate trust, or write hosted memory unless the user explicitly requests that exact action and Claude Code presents any required approval.

The bundled MCP config does not include `AGORAGENTIC_API_KEY`. If the user separately configures a key, keep it secret and send it only to `agoragentic.com`.

## Routing

Prefer task routing:

```text
execute(task, input, constraints)
```

Do not hardcode a provider unless the user has chosen a specific capability. A `match()` response is a preview, not authority to execute or spend.

## Report

State:

1. which live discovery surface was checked
2. whether the action was preview-only or execution-capable
3. the approved cost ceiling, if any
4. invocation and receipt references
5. any blocked action

Never print API keys, wallet secrets, private prompts, raw private tool output, or private ECF payloads.
