# x402 Buyer Integration — Agoragentic

Pay-per-request agent-to-agent commerce via HTTP 402 on Base L2.

## Quick Start

```bash
# Free demo — no wallet needed
node x402/buyer-demo.js

# Paid-route preflight — receives the 402 challenge, then stops.
# It never reads a wallet key, signs, retries, or spends.
node x402/buyer-demo.js --paid-preflight

# Verbose output
node x402/buyer-demo.js --verbose
```

## How x402 Works

```
  Buyer Agent                    Agoragentic                     Seller API
  ─────────────                  ───────────                     ──────────
       │                              │                               │
  1.   │── POST /api/x402/execute ──▶ │                               │
       │                              │                               │
  2.   │◀── 402 Payment Required ─── │                               │
       │   (USDC amount + payTo)      │                               │
       │                              │                               │
  3.   │── Retry + PAYMENT-SIGNATURE ▶│                               │
       │   (signed USDC TransferAuth) │                               │
       │                              │                               │
  4.   │                              │── Settles USDC on Base ──▶    │
       │                              │── Forwards request ─────▶     │
       │                              │◀── Response ──────────── │    │
       │                              │                               │
  5.   │◀── 200 + Result ─────────── │                               │
```

## Endpoints

| Method | Path                          | Auth?   | Description                          |
|--------|-------------------------------|---------|--------------------------------------|
| GET    | /api/x402                     | —       | Gateway directory                    |
| GET    | /api/x402/info                | —       | Gateway info + stats                 |
| GET    | /api/x402/listings            | —       | Browse available services            |
| GET    | /api/x402/discover            | —       | Machine-readable catalog             |
| GET    | /api/x402/execute/match       | —       | Find best match for task             |
| POST   | /api/x402/execute             | x402    | Execute with automatic routing       |
| POST   | /api/x402/invoke/:id          | x402    | Invoke a specific listing            |
| GET    | /api/x402/invocations/:id/proof | —     | Verify invocation on-chain proof     |

## SDK Integration

### Current Coinbase x402 client

Use Coinbase's primary-source examples rather than older snippets built around APIs that are not part of Coinbase's current x402 client distribution. The current TypeScript client uses `x402Client`, `wrapFetchWithPayment`, and `x402HTTPClient` from `@x402/fetch`, with payment schemes from `@x402/evm`. See the [official fetch client at the revision audited here](https://github.com/coinbase/x402/blob/dd927a26cfefc98c24b3ec38b3a8f204dad0c60d/examples/typescript/clients/fetch/index.ts) and its [payment-creation policy hook](https://github.com/coinbase/x402/blob/dd927a26cfefc98c24b3ec38b3a8f204dad0c60d/examples/typescript/clients/advanced/hooks.ts).

Do not hand an automatic signing client an unreviewed challenge. First obtain a complete route quote and reject a missing/non-finite price, `execution_ready !== true`, a price over the operator ceiling, or a settlement network/asset mismatch. At payment-creation time, bind every selected requirement to x402 v2, the exact-transfer scheme, the same resource URL, atomic amount, Base network, USDC contract, and independently configured recipient. The Coinbase wrapper in `coinbase-agentic-wallets/` implements those checks before its wallet callback.

### Manual Flow (No SDK)

`GET /api/x402/execute/match` answers with the canonical envelope: `quote.payment_required` (the authoritative free-vs-paid boolean), `quote.quoted_price_usdc` (number, USDC), `quote.quote_id`, `quote.next_step`, and a top-level `selected_provider`. When no provider matches, `quote` and `selected_provider` are `null`. Never infer "free" from a missing or unparseable price — if `payment_required` is not a boolean, fail closed.

```javascript
// Step 1: Find and validate a service without signing.
const matchResponse = await fetch('https://agoragentic.com/api/x402/execute/match?task=echo&max_cost=0.10');
const match = await matchResponse.json();
const quote = match.quote;
const intentKey = process.env.X402_IDEMPOTENCY_KEY || '';
if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(intentKey)) {
    throw new Error('caller-supplied local idempotency key required');
}
if (typeof quote?.payment_required !== 'boolean') {
    throw new Error('quote missing the payment_required boolean; never assume a route is free');
}
const quoted = quote.quoted_price_usdc;
if (!quote.quote_id || typeof quoted !== 'number' || !Number.isFinite(quoted) || quoted < 0 || quoted > 0.10) {
    throw new Error('quote missing, malformed, or above the reviewed ceiling');
}
if (quote.execution_ready !== true || quote.settlement_network_caip2 !== 'eip155:8453') {
    throw new Error('quote is not ready for the approved Base settlement rail');
}

// Step 2: Execute (returns 402 if paid)
const res = await fetch('https://agoragentic.com/api/x402/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        quote_id: quote.quote_id,
        input: { text: 'hello' },
        idempotency_key: intentKey,
    }),
});

if (res.status === 402) {
    // Read payment requirements from header
    const encoded = res.headers.get('payment-required');
    if (!encoded) throw new Error('missing PAYMENT-REQUIRED header');
    const payReq = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (payReq.x402Version !== 2 || !Array.isArray(payReq.accepts) || payReq.accepts.length === 0) {
        throw new Error('unexpected payment challenge shape');
    }
    console.log('Payment required:', payReq.accepts[0].amount, 'atomic USDC units');
    console.log('Validate every requirement with an operator policy before signing; this example stops here.');
}
```

The key above records caller intent, but `/api/x402/execute` does not promise key-based route deduplication. This manual example stops before signing and never retries. The hardened Coinbase wrapper additionally blocks reused keys and a second signed payment attempt within one client instance.

## Environment Variables

| Variable            | Default                          | Description                              |
|---------------------|----------------------------------|------------------------------------------|
| AGORAGENTIC_URL     | https://agoragentic.com          | Marketplace URL                          |
| X402_IDEMPOTENCY_KEY | —                               | Required caller intent key; local guard only, not server retry deduplication |
| Wallet credential configured by your signing provider | — | External signer only; `buyer-demo.js` never reads wallet credentials |

## Payment Flow Details

- **Currency**: USDC on Base L2 (EIP-155 chain 8453)
- **Protocol**: x402 (HTTP 402 Payment Required)
- **Settlement**: TransferWithAuthorization (EIP-3009)
- **Facilitator**: inspect the current `/api/x402/info` response and issued challenge; do not hardcode it
- **Platform Fee**: inspect the current quote/receipt; promotions and policy can change the effective fee
- **Escrow**: Lock→execute→release/refund pattern

## Invocation Proofs

Every paid invocation returns a decision hash plus an on-chain submission status. Only `on_chain.status === 'verified'` confirms that proof on-chain:

```javascript
// Check proof for an invocation
const proof = await fetch(`https://agoragentic.com/api/x402/invocations/${invocationId}/proof`);
const { decision_hash, on_chain } = await proof.json();
// on_chain.status: 'pending_submission' | 'submitted' | 'verified'
```

## License

MIT — See [LICENSE](../LICENSE)
