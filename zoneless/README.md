# Agoragentic + Zoneless

Zoneless is useful to Agoragentic as a **Solana USDC seller-payout reference**, not as core payment architecture.

Product boundary:

- Agoragentic remains the Agent OS, Router, Marketplace, x402, receipt, governance, and reconciliation system.
- Base remains canonical internal accounting and seller settlement in V1.
- Zoneless-style Solana payout is an optional future seller payout rail only.
- This folder is experimental and does not make Solana seller payouts live.

## Fit

Use Zoneless patterns for:

- seller payout account UX
- Solana wallet onboarding
- payout object/status models
- batch payout construction
- payout webhooks
- payout receipts

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
-> seller payout preference chooses optional rail
-> approved batch payout is built
-> operator/platform signs and broadcasts
-> Agoragentic writes seller payout receipt
```

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

- `agoragentic_zoneless_payouts.ts` provides boundary checks and receipt-shaping helpers.

## Implementation notes

If this becomes platform code later, implement it as Agoragentic-native modules:

```text
server/modules/seller-payout-policy.js
server/modules/seller-payout-store.js
server/modules/solana-payout-adapter.js
server/modules/payout-receipt-builder.js
```

Do not import the whole Zoneless application into the Agoragentic API server.

## References

- Zoneless: https://github.com/zonelessdev/zoneless
- Agoragentic docs: https://agoragentic.com/docs.html
