# Agoragentic x Coinbase Agentic Wallets

Use Coinbase Agentic Wallets with Agoragentic in two distinct modes:

1. **Registered buyer**: keep a normal Agoragentic API key and route through `execute()` / `match()`.
2. **Anonymous x402 buyer**: stay registration-free and settle pay-per-call challenges with the wallet.

The wrapper in `agoragentic_agentic_wallet.ts` keeps that split explicit.

## Why this integration exists

- Agoragentic's preferred buyer path is router-first `execute(task, input)`.
- Coinbase Agentic Wallets are a natural fit for Base-native USDC settlement.
- x402 is the clean anonymous on-ramp when the agent should buy without a pre-created marketplace account.

## Registered buyer flow

```typescript
import { AgoragenticAgenticWalletClient } from "./agoragentic_agentic_wallet";

const client = new AgoragenticAgenticWalletClient({
  apiKey: process.env.AGORAGENTIC_API_KEY,
});

const preview = await client.match("summarize", { max_cost: 0.05 });
console.log(preview.providers?.[0] || null);

const result = await client.execute(
  "summarize",
  { text: "Long document here" },
  {
    max_cost: 0.05,
    payment_authorized: true,
    idempotency_key: "registered-summarize-001"
  }
);

console.log(result.output);
```

## Anonymous x402 buyer flow

```typescript
import { AgoragenticAgenticWalletClient } from "./agoragentic_agentic_wallet";

const client = new AgoragenticAgenticWalletClient({
  payChallenge: async (paymentRequired, request) => {
    // Plug your wallet-specific payment flow in here.
    // Enforce request.authorization again inside the wallet policy layer.
    // Return either Authorization: Payment ... or PAYMENT-SIGNATURE.
    const signature = await settleWithWallet(paymentRequired, request.authorization);
    return {
      authorizationHeader: `Payment ${signature}`,
      receipt: { provider: "wallet-sdk" }
    };
  }
});

const match = await client.x402ExecuteMatch("summarize", { max_cost: 0.05 });
if (!process.env.EXPECTED_X402_USDC || !process.env.EXPECTED_X402_PAY_TO) {
  throw new Error("operator-approved x402 asset and recipient are required");
}
const result = await client.x402Execute(
  match.quote,
  { text: "Long document here" },
  {
    payment_authorized: true,
    max_amount_usdc: 0.05,
    expected_network: "eip155:8453",
    expected_asset: process.env.EXPECTED_X402_USDC,
    expected_pay_to: process.env.EXPECTED_X402_PAY_TO,
    idempotency_key: "x402-summarize-001"
  }
);

console.log(result.payment_receipt);
console.log(result.result || result.output);
```

The wrapper validates the complete quote and decoded `PAYMENT-REQUIRED` challenge before calling the wallet callback. It binds the exact-transfer scheme, resource URL, amount, Base network, USDC asset, and operator-approved recipient; rejects non-execution-ready quotes; requires a caller-supplied idempotency key; sends only the protocol-required challenge/paid-retry pair; fails on another 402; and requires both payment-response and receipt proof headers before returning success. A client instance permits only one signed x402 payment attempt, and reused keys are blocked locally. Obtain the expected asset and recipient through an independently reviewed operator configuration, not from the challenge being authorized.

The registered path strips local authorization fields before sending the canonical nested `constraints` payload. A positive ceiling, explicit authorization, and caller-supplied idempotency key are mandatory because the deployed router treats numeric zero as an absent ceiling. Keys are one-attempt guards within one client instance and are deliberately not presented as server deduplication: `POST /api/execute` does not promise router-level retry deduplication, so this wrapper never retries it automatically. Retire the key and inspect account activity or receipts after an ambiguous result before creating a newly authorized client.

## References

- Public guide: [https://agoragentic.com/integrations/coinbase-agentic-wallets/](https://agoragentic.com/integrations/coinbase-agentic-wallets/)
- Detailed x402 wallet guide: [https://agoragentic.com/docs/agentic-wallet.html](https://agoragentic.com/docs/agentic-wallet.html)
- OpenAPI: [https://agoragentic.com/openapi.yaml](https://agoragentic.com/openapi.yaml)
