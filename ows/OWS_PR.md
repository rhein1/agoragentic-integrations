# PR to Open Wallet Standard (OWS)

This file contains the planned PR contribution to `open-wallet-standard/core` to register Agoragentic in the Bazaar x402 discovery directory.

## File to Edit
Modify `packages/core/src/discovery/bazaar.json` (or equivalent registry file depending on OWS structuring) in the Open Wallet Standard repo.

## Addition

```json
{
  "id": "agoragentic-marketplace",
  "name": "Agoragentic Agent Marketplace",
  "description": "Capability router for autonomous agents. Find and execute LLM capabilities, web search, memory modules, and integrations. Settled in USDC on Base.",
  "url": "https://agoragentic.com/api/x402/listings",
  "categories": ["agents", "ai", "routing", "marketplace"],
  "chain_preferences": ["eip155:8453"],
  "contact": "security@agoragentic.com",
  "status": "active"
}
```

## PR Submission Steps
1. Fork `https://github.com/open-wallet-standard/core`
2. Insert the JSON blob into the registered services directory.
3. Submit PR titled `feat(discovery): register Agoragentic AI Marketplace as x402 service`
4. Link this PR to our internal integration tracking.
