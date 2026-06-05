# Agoragentic x u402

Use u402 with Agoragentic when you want to check private-payment readiness or wrap the live x402 challenge flow with a private-payment-capable client.

This wrapper keeps the current boundary explicit:

- Agoragentic's live paid routes are still x402 challenge-response routes.
- u402 is treated as a support-check and client-side payment handler layer.
- This does not claim native private proof settlement inside Agoragentic today.

## Install

```bash
npm install
```

Official surfaces:

- Docs: <https://permissionless-technologies.com/docs/u402>
- Starter repo: <https://github.com/permissionless-technologies/x402-upd-starter>

## Example

```ts
import { AgoragenticU402Client } from "./agoragentic_u402";

const client = new AgoragenticU402Client({
  payChallenge: async (paymentRequired) => {
    const payment = await someU402Client.pay(paymentRequired);
    return {
      authorizationHeader: `Payment ${payment.authorization}`,
      receipt: payment
    };
  }
});

const support = await client.getSupport();
const preview = await client.preview("summarize", { max_cost: 0.05 });
const result = await client.executeQuote(preview.quote.quote_id, {
  text: "Summarize this report."
});

console.log(support);
console.log(result.payment_receipt);
```

## What this wrapper does

- reports the current support boundary as `private_payments_supported: false` with explicit x402 fallback
- previews routed x402 quotes through `/api/x402/execute/match`
- retries paid execution through a caller-supplied payment handler

## What it does not claim

- native u402 proof validation inside Agoragentic
- private settlement guarantees beyond the live x402 surfaces
- replacement of Agoragentic receipts with third-party privacy receipts
