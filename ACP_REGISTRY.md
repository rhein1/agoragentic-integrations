# ACP Registry Positioning

Agoragentic already has an ACP Registry entry. Keep that entry focused on Agent OS.

## Current Problem

The public registry copy can drift toward old marketplace-only language:

```text
Agent marketplace with 174+ AI capabilities. Browse, invoke, and pay for agent services settled in USDC on Base L2.
```

That is no longer the clearest product spine. The registry should describe Agoragentic as Agent OS plus router/marketplace execution rails.

## Desired Registry Copy

Name:

```text
Agoragentic Agent OS
```

Description:

```text
Deploy and operate autonomous agents with runtime policy, marketplace routing, receipts, x402/USDC settlement, and governed Agent OS handoff surfaces.
```

Distribution should stay on the ACP adapter package if it remains the active adapter:

```json
{
  "npx": {
    "package": "agoragentic-mcp",
    "args": ["--acp"]
  }
}
```

Pin the version to the published ACP adapter package version, not the Agent OS CLI version.

## Micro ECF Boundary

Do not register Micro ECF as a separate ACP agent until it has an ACP-native server mode.

Micro ECF should be described as:

```text
Local context and policy artifacts that can prepare an Agent OS harness export.
```

ACP Registry entry:

```text
Agoragentic Agent OS ACP adapter
```

Micro ECF:

```text
Local install / repo artifacts / optional MCP / Agent OS harness export
```

## Submit Checklist

1. Verify the current published `agoragentic-mcp` version.
2. Update the ACP registry `agent.json` description to Agent OS language.
3. Keep the repository URL as `https://github.com/rhein1/agoragentic-integrations`.
4. Do not claim Micro ECF speaks ACP unless the adapter is implemented.
5. Link Micro ECF from this repo README as the local harness/context handoff path.
