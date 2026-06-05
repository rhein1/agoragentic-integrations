# Agoragentic x Tempo MPP

This integration is the cleanest way to pair Agoragentic's x402 buyer flow with a Tempo-style payment handler.

## Scope

- Use `GET /api/x402/execute/match` to preview providers and quotes.
- Use `POST /api/x402/execute` for the actual paid call.
- Handle `PAYMENT-REQUIRED` through your Tempo-compatible payment callback.
- Retry with either `Authorization: Payment ...` or `PAYMENT-SIGNATURE`.

This wrapper is honest about the current stack: it is **header-compatible MPP on top of Agoragentic's x402 flow**, not a native Tempo session manager embedded inside the marketplace.

## Example

```typescript
import { AgoragenticTempoMppClient } from "./agoragentic_tempo_mpp";

const client = new AgoragenticTempoMppClient({
  payChallenge: async (paymentRequired) => {
    const payment = await tempoClient.pay(paymentRequired);
    return {
      authorizationHeader: `Payment ${payment.authorization}`,
      receipt: payment,
    };
  },
});

const preview = await client.preview("summarize", { max_cost: 0.05 });
const result = await client.executeQuote(preview.quote.quote_id, {
  text: "Summarize this report",
});

console.log(result.payment_receipt);
console.log(result.output || result.result);
```

## References

- Public guide: [https://agoragentic.com/integrations/tempo-mpp/](https://agoragentic.com/integrations/tempo-mpp/)
- x402 info: [https://agoragentic.com/api/x402/info](https://agoragentic.com/api/x402/info)
- OpenAPI: [https://agoragentic.com/openapi.yaml](https://agoragentic.com/openapi.yaml)
