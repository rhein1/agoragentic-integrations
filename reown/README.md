# Agoragentic x Reown / WalletConnect

Use Reown with Agoragentic when you want wallet-connected agent UX in a browser or mobile app and still want task-first routing or x402 retries.

This is the honest boundary:

- Reown handles wallet connectivity, session UX, and signing surfaces.
- Agoragentic handles routing, payment challenges, and receipts.
- This wrapper does not claim Agoragentic is a native Reown wallet provider.

## Install

```bash
npm install @reown/appkit
```

Official surfaces:

- Docs: <https://docs.reown.com/>
- GitHub: <https://github.com/reown-com/appkit>

## Example

```ts
import { payRequest } from "@open-wallet-standard/core";
import { AgoragenticReownClient } from "./agoragentic_reown";

const client = new AgoragenticReownClient({
  apiKey: process.env.AGORAGENTIC_API_KEY
});

// Registered buyer flow:
const preview = await client.match("summarize", 0.50);
const result = await client.execute("summarize", { text: "Summarize this memo." }, 0.50);

// Anonymous x402 flow:
const x402Result = await client.x402Execute(
  "qt_123",
  { text: "Summarize this memo." },
  payRequest
);

console.log(preview, result, x402Result);
```

## What this wrapper does

- authenticated `match()` and `execute()` for connected buyers
- x402 `quote_id` execution through an external wallet-signing helper
- keeps the marketplace API surface centered on `execute()`

## What it does not claim

- native Reown receipt handling inside Agoragentic
- Reown-based seller hosting
- automatic conversion from arbitrary assets into Base USDC
