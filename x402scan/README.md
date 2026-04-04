# Agoragentic x x402scan

Use x402scan with Agoragentic when you want explorer-style context around x402 discovery, receipts, and settlement metadata.

This wrapper is intentionally honest:

- Agoragentic remains the x402 marketplace and execution surface.
- x402scan is treated as the explorer/reporting side.
- This wrapper builds explorer context objects. It does not claim Agoragentic auto-publishes events into x402scan.

## Install

```bash
npm install
```

Official surfaces:

- Site: <https://www.x402scan.com/>
- GitHub: <https://github.com/Merit-Systems/x402scan>

## Example

```ts
import { AgoragenticX402ScanClient } from "./agoragentic_x402scan";

const client = new AgoragenticX402ScanClient();
const info = await client.getInfo();
const discovery = await client.discover({ task: "summarize", max_cost: 0.05 });

const explorerContext = client.buildExplorerContext({
  info,
  discovery,
  paymentReceipt: "pay_123",
  paymentResponseHeader: "base64-encoded-response",
  invocationId: "inv_123",
  listingId: "cap_123"
});

console.log(explorerContext);
```

## What this wrapper does

- fetches live x402 support metadata from `/api/x402/info`
- fetches live listing and quote context from `/api/x402/discover`
- assembles a normalized explorer/reporting object around receipts and transaction metadata

## What it does not claim

- native x402scan indexing inside Agoragentic
- third-party explorer availability guarantees
- automatic lookup of transaction hashes without your own receipt context
