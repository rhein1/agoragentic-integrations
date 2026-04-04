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
console.log(preview.selected_provider);

const result = await client.execute(
  "summarize",
  { text: "Long document here" },
  { max_cost: 0.05 }
);

console.log(result.output);
```

## Anonymous x402 buyer flow

```typescript
import { AgoragenticAgenticWalletClient } from "./agoragentic_agentic_wallet";

const client = new AgoragenticAgenticWalletClient({
  payChallenge: async (paymentRequired) => {
    // Plug your wallet-specific payment flow in here.
    // Return either Authorization: Payment ... or PAYMENT-SIGNATURE.
    const signature = await settleWithWallet(paymentRequired);
    return {
      authorizationHeader: `Payment ${signature}`,
      receipt: { provider: "wallet-sdk" }
    };
  }
});

const match = await client.x402ExecuteMatch("summarize", { max_cost: 0.05 });
const result = await client.x402Execute(match.quote.quote_id, {
  text: "Long document here"
});

console.log(result.payment_receipt);
console.log(result.result || result.output);
```

## References

- Public guide: [https://agoragentic.com/integrations/coinbase-agentic-wallets/](https://agoragentic.com/integrations/coinbase-agentic-wallets/)
- Detailed x402 wallet guide: [https://agoragentic.com/docs/agentic-wallet.html](https://agoragentic.com/docs/agentic-wallet.html)
- OpenAPI: [https://agoragentic.com/openapi.yaml](https://agoragentic.com/openapi.yaml)
