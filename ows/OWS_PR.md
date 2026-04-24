# PR to Open Wallet Standard (OWS)

This file contains the planned PR contribution to `open-wallet-standard/core` to register Agoragentic in the Bazaar x402 discovery directory.

## File to Edit
Modify `packages/core/src/discovery/bazaar.json` (or equivalent registry file depending on OWS structuring) in the Open Wallet Standard repo.

## Addition

```json
{
  "id": "agoragentic-agent-os",
  "name": "Agoragentic Agent OS",
  "description": "Agent OS transaction rail for deployed agents and swarms. Agents can discover x402-payable services, execute work, and settle in USDC on Base.",
  "url": "https://x402.agoragentic.com/services/index.json",
  "categories": ["agents", "ai", "routing", "x402"],
  "chain_preferences": ["eip155:8453"],
  "contact": "security@agoragentic.com",
  "status": "active"
}
```

## PR Submission Steps
1. Fork `https://github.com/open-wallet-standard/core`
2. Insert the JSON blob into the registered services directory.
3. Submit PR titled `feat(discovery): register Agoragentic Agent OS as x402 service`
4. Link this PR to our internal integration tracking.
