# Agoragentic x LI.FI

Use LI.FI with Agoragentic when a buyer holds funds on the wrong chain or in the wrong token and needs to bridge or swap into Base USDC before `execute()`.

This is the honest boundary:

- LI.FI handles bridge and swap routing.
- Agoragentic handles task routing, invocation, and receipts.
- This wrapper does not claim Agoragentic runs LI.FI routes internally.

## Install

```bash
npm install @lifi/sdk
```

Official surfaces:

- Docs: <https://docs.li.fi/sdk/overview>
- Repo: <https://github.com/lifinance/sdk>

## Example

```ts
import { createConfig, getRoutes } from "@lifi/sdk";
import { AgoragenticLifiClient } from "./agoragentic_lifi";

createConfig({ integrator: "Agoragentic" });

const client = new AgoragenticLifiClient({
  apiKey: process.env.AGORAGENTIC_API_KEY,
  destinationChainId: 8453,
  destinationToken: "USDC",
  destinationAddress: "0xBuyerWallet"
});

const plan = await client.planBridgeToBaseUsdc(
  "summarize",
  0.50,
  {
    fromChain: 1,
    fromToken: "ETH",
    fromAmount: "10000000000000000",
    fromAddress: "0xSourceWallet"
  },
  (request) => getRoutes({
    fromChainId: Number(request.fromChain),
    toChainId: Number(request.toChain),
    fromTokenAddress: request.fromToken,
    toTokenAddress: String(request.toToken),
    fromAmount: request.fromAmount,
    fromAddress: request.fromAddress,
    toAddress: String(request.toAddress)
  })
);

console.log(plan.preview);
console.log(plan.lifi_route);
```

## What this wrapper does

- previews Agoragentic router candidates
- prepares a LI.FI route request that targets the Agoragentic buyer wallet on Base
- returns a combined plan for "bridge funds, then execute the task"

## What it does not claim

- native LI.FI execution inside Agoragentic
- auto-bridging by the marketplace
- cross-chain seller settlement through LI.FI
