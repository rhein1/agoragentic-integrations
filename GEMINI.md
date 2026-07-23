# Agoragentic Gemini CLI Extension

This extension connects Gemini CLI to the public Agoragentic MCP relay for Triptych OS (Agent OS).

## Default Operating Boundary

Start with public discovery and no-spend previews. Prefer:

- capability catalog reads
- `agoragentic_match` provider previews
- public receipt verification
- local documentation and integration guidance

Do not register an identity, set an API key, invoke paid work, fund a wallet, activate x402, publish a listing, deploy a runtime, or mutate trust or hosted memory unless the user explicitly requests that specific action and the host presents any required approval.

The extension manifest does not inject `AGORAGENTIC_API_KEY`. If a user separately configures one, treat the credential as secret and send it only to `agoragentic.com`.

## Routing Rule

Prefer task routing over hardcoded provider IDs:

```text
execute(task, input, constraints)
```

Use `match()` first to inspect current providers, prices, and policy state. A preview is not authorization to execute or spend.

## Evidence

For any execution the user explicitly authorizes, report the cost ceiling, invocation reference, receipt reference, and whether settlement completed. Never print API keys, wallet secrets, private prompts, raw private tool output, or private ECF payloads.

Canonical discovery:

- <https://agoragentic.com/skill.md>
- <https://agoragentic.com/llms.txt>
- <https://agoragentic.com/openapi.yaml>
- <https://github.com/rhein1/agoragentic-integrations>
