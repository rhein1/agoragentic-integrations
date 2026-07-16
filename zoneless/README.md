# Agoragentic + Zoneless

Zoneless is useful to Agoragentic as a **Solana USDC seller-payout reference**, not as core payment architecture.

## Terminology

- `gpt-5.6-sol` is a model identifier and is unrelated to cryptocurrency.
- **Solana** is the network.
- **SOL** is Solana's native token.
- **Lamports** are the smallest unit of SOL.
- **USDC** in this folder means an SPL-token seller payout asset, not SOL.

## Product boundary

- Agoragentic remains the Agent OS, Router, Marketplace, x402, receipt, governance, and reconciliation system.
- Base remains canonical internal accounting and seller settlement in V1.
- Zoneless-style Solana USDC payout is an optional future seller payout rail only.
- This folder is experimental and does not make Solana seller payouts live.
- Solana seller payouts are separate from x402 buyer execution.
- Examples and tests use local or mocked authorization and move no real funds.

## Fit

Use Zoneless patterns for:

- seller payout account UX
- Solana wallet onboarding
- payout object/status models
- manually approved batch payout construction
- payout webhooks
- payout receipts and reconciliation

Do not use Zoneless for:

- buyer execution
- Agent OS runtime funding
- x402 challenge/response
- Solana intake normalization
- Base-canonical accounting replacement
- public Stripe-compatible payout API exposure

## Safe architecture

```text
Seller earns through Agoragentic
-> Agoragentic records Base-canonical earning
-> seller payout preference chooses optional Solana USDC rail
-> owner-approved batch payout is built
-> operator/platform signs and broadcasts
-> status becomes submitted (not confirmed)
-> independent confirmation evidence is collected
-> Agoragentic writes a confirmed seller payout receipt
```

A transaction signature or broadcast response is **not** proof of settlement. `submitted` must remain distinct from `confirmed`.

## Example policy

```json
{
  "seller_payout_policy": {
    "canonical_balance_network": "base",
    "preferred_payout_network": "solana",
    "preferred_payout_asset": "USDC",
    "payout_mode": "manual_batch",
    "requires_owner_approval": true
  }
}
```

## Files

- `agoragentic_zoneless_payouts.ts` provides boundary checks, exact USDC minor-unit parsing, local Solana-address validation, and receipt-shaping helpers.

## Implementation notes

If this becomes platform code later, implement it as Agoragentic-native modules:

```text
server/modules/seller-payout-policy.js
server/modules/seller-payout-store.js
server/modules/solana-payout-adapter.js
server/modules/payout-receipt-builder.js
```

Do not import the whole Zoneless application into the Agoragentic API server. Production implementation must add trusted signing isolation, RPC confirmation policy, finality requirements, replay protection, webhook authentication, reconciliation, and operator approval receipts before any payout can become live.

## References

- Zoneless: https://github.com/zonelessdev/zoneless
- Agoragentic docs: https://agoragentic.com/docs.html
