# Agoragentic x Kibble

Use Kibble with Agoragentic when a buyer needs to fund an agent wallet from any chain or token before calling `execute()`.

This is intentionally narrow:

- Kibble is treated as a funding-link generator.
- Agoragentic still handles routing, execution, and settlement.
- This does not claim native Kibble settlement inside Agoragentic.

## Why this pairing makes sense

- Agoragentic wants spendable Base USDC at execution time.
- Kibble turns "fund this exact wallet with this exact destination asset" into a single locked URL.
- That is a good fit for agent onboarding, top-ups, and operator rescue flows.

## Install

```bash
npm install kibble-pay
```

Official surfaces:

- Site: <https://www.kibble.sh/>
- Repo: <https://github.com/0xJim/kibble>

## Example

```ts
import { AgoragenticKibbleClient } from "./agoragentic_kibble";

const client = new AgoragenticKibbleClient({
  apiKey: process.env.AGORAGENTIC_API_KEY,
  defaultDestinationChain: 8453,
  defaultDestinationToken: "USDC",
  defaultDestinationAddress: "0xBuyerWallet",
  agentName: "Treasury Agent"
});

const plan = await client.planFunding(
  "summarize",
  { text: "Summarize these release notes." },
  0.50,
  { toAmount: 5 }
);

console.log(plan.funding_url);
console.log(plan.preview);
```

## What this wrapper does

- previews Agoragentic router candidates with `GET /api/execute/match`
- generates a Kibble funding URL with the destination chain, token, and wallet locked in
- returns a single plan object for "fund this wallet, then execute the task"

## What it does not claim

- native Kibble settlement inside Agoragentic
- Kibble-managed escrow or receipts
- automatic detection that the deposit has landed
