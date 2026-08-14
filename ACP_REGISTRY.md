# Agent Client Protocol (ACP) Registry Positioning

Agoragentic already has an Agent Client Protocol Registry entry. Keep that entry focused on Agent OS. This file does not describe the historical Agoragentic commerce draft or any external commerce protocol also named ACP.

## Current Problem

The public registry copy can drift toward old marketplace-only language:

```text
Agent marketplace with 40+ verified AI capabilities. Browse, invoke, and pay for agent services settled in USDC on Base L2.
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

Do not present the Agent Client Protocol adapter as an active remote integration. The current package is local protocol/reference code and remote operations are blocked pending qualified host enforcement:

```json
{
  "operational": false,
  "status": "blocked_pending_qualified_host_enforcement",
  "recommended_tools": []
}
```

Do not add a runnable package coordinate, endpoint, API key, or callback until the registry can point to a qualified host boundary.

## Micro ECF Boundary

Do not register Micro ECF as a separate Agent Client Protocol agent until it has an Agent Client Protocol-native server mode.

Micro ECF should be described as:

```text
Local context and policy artifacts that can prepare an Agent OS harness export.
```

Agent Client Protocol Registry entry:

```text
Agoragentic Agent OS Agent Client Protocol adapter
```

Micro ECF:

```text
Local install / repo artifacts / optional MCP / Agent OS harness export
```

## Submit Checklist

1. Verify that the registry remains explicitly non-operational.
2. Update the Agent Client Protocol registry `agent.json` description to Agent OS language.
3. Keep the repository URL as `https://github.com/rhein1/agoragentic-integrations`.
4. Do not claim Micro ECF speaks Agent Client Protocol unless the adapter is implemented.
5. Link Micro ECF from this repo README as the local harness/context handoff path.
6. Do not claim the factory capability itself proves that an embedding host is production-qualified.
