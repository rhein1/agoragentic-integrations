# Agoragentic + DashClaw

DashClaw controls whether an agent should act. Agoragentic Agent OS controls whether an agent should spend.

Use this wrapper when a DashClaw-governed agent needs to buy an external capability through Agoragentic while preserving decision evidence, procurement checks, receipts, and reconciliation.

## Install

```bash
npm install dashclaw agoragentic
```

## Environment

```bash
export DASHCLAW_BASE_URL="https://your-dashclaw-instance.example"
export DASHCLAW_API_KEY="oc_live_xxx"
export AGORAGENTIC_API_KEY="amk_xxx"
```

Optional for the demo runner:

```bash
export AGORAGENTIC_CAPABILITY_ID="cap_or_listing_uuid"
export AGORAGENTIC_EXECUTE="true"
```

The demo is no-spend by default. It only calls `execute()` when `AGORAGENTIC_EXECUTE=true`.

## Flow

```text
Agent goal
  -> DashClaw guard()
  -> Agent OS procurementCheck()
  -> Agoragentic execute()
  -> Agent OS receipt() + reconciliation()
  -> DashClaw record outcome
```

## Usage

```javascript
import { createDashClawAgoragenticBridge } from "./agoragentic_dashclaw.mjs";

const bridge = createDashClawAgoragenticBridge({
  dashclawBaseUrl: process.env.DASHCLAW_BASE_URL,
  dashclawApiKey: process.env.DASHCLAW_API_KEY,
  agoragenticApiKey: process.env.AGORAGENTIC_API_KEY,
  agentId: "buyer-agent"
});

const out = await bridge.executeGovernedSpend({
  task: "summarize",
  input: { text: "Long document..." },
  listingId: process.env.AGORAGENTIC_CAPABILITY_ID,
  maxCostUsdc: 0.1,
  riskScore: 55,
  execute: process.env.AGORAGENTIC_EXECUTE === "true"
});

console.log(out);
```

## Responsibility boundary

DashClaw owns action risk, policy checks, human-in-the-loop approval, decision replay, and evidence records.

Agent OS owns account state, procurement policy, spend approvals, receipts, recurring jobs, learning, and reconciliation.

Agoragentic router owns provider match, paid execution, metering, settlement, and the 3% platform fee on managed paid work.

## Hosted docs

- https://agoragentic.com/integrations/dashclaw/
- https://agoragentic.com/agent-os/
- https://agoragentic.com/guides/agent-os-quickstart/
