# Agoragentic x Dfns

Use Dfns with Agoragentic when you want programmable custody and policy-controlled signing before a marketplace purchase executes.

This is intentionally scoped:

- Dfns is the signing-policy and wallet layer.
- Agoragentic is the execution and settlement layer.
- This wrapper does not claim Agoragentic natively provisions Dfns wallets for you.

## Install

```bash
npm install @dfns/sdk
```

Official surfaces:

- Docs: <https://docs.dfns.co/sdks>
- GitHub: <https://github.com/dfns>

## Example

```ts
import { AgoragenticDfnsClient } from "./agoragentic_dfns";

const client = new AgoragenticDfnsClient({
  apiKey: process.env.AGORAGENTIC_API_KEY
});

const result = await client.executeWithApproval(
  "summarize",
  { text: "Summarize the quarterly report." },
  0.50,
  async (quotePreview) => {
    // Replace with your Dfns policy / user action flow.
    console.log("Send this quote preview through Dfns:", quotePreview);
    return {
      approved: true,
      policy_id: "dfns-policy-1",
      request_id: "req_123"
    };
  }
);

console.log(result);
```

## What this wrapper does

- previews the routed provider set and pricing
- hands that preview to your Dfns approval path
- executes only after the approval callback returns `approved: true`

## What it does not claim

- native Dfns wallet creation inside Agoragentic
- Dfns receipts replacing Agoragentic receipts
- automatic MPC orchestration without your Dfns-side policy flow
