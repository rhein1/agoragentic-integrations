# Agoragentic + Zoneless

Zoneless is useful to Agoragentic as a **Solana USDC seller-payout reference**, not as core payment architecture.

**Offline reference only.** This folder has no HTTP client, credentials, signer, broadcaster, chain verifier, or execution authority. It does not change the platform custody freeze, enable payments, or authenticate the reference data supplied by a caller.

## Terminology

- `gpt-5.6-sol` is a model identifier and is unrelated to cryptocurrency.
- **Solana** is the network.
- **SOL** is Solana's native token.
- **Lamports** are the smallest unit of SOL.
- **USDC** in this folder means an SPL-token seller payout asset, not SOL.
- **Atomic units** here are six-decimal USDC units: one USDC is 1,000,000 atomic units.
- **Zoneless API cents** are a different unit: one USDC is 100 cents.

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

## Two different contracts

The upstream contract was inspected at Zoneless commit `314414420494f63863015a060d231a7329b620e1` on September 8, 2026. This is a pinned source-level comparison, not an upstream deployment or end-to-end qualification.

| Field | Agoragentic internal draft | Upstream payout request body |
| --- | --- | --- |
| Amount | `amount_atomic_units`: exact six-decimal string | `amount`: positive integer cents |
| Destination | `destination_wallet_address`: raw Solana address | `destination`: registered `wa_z_...` wallet ID |
| Account | Agoragentic seller ID | Connected `acct_z_...` account supplied separately |
| Authority | None | Requires authenticated platform/account authorization outside this helper |

For **10 USDC**, the internal amount is `"10000000"`, but the upstream amount is `1000`. Coercing the old atomic-unit string to a number would produce a **10,000x unit error**.

`parseUsdcMinorUnits()` retains exact six-decimal accounting. `toZonelessCents()` divides atomic units by 10,000 using `bigint`, rejects any remainder, and checks `Number.MAX_SAFE_INTEGER` before conversion to the JSON number. Sub-cent amounts are not rounded, truncated, or accumulated automatically. The safe-integer check covers the request representation, not downstream chain arithmetic or operational limits.

`buildSellerPayoutDraft()` builds an explicitly internal draft with no API-shaped `amount` or `destination` fields. `buildZonelessPayoutRequestDraft()` separately builds an offline envelope containing `body` and `request_options.zonelessAccount`. The latter corresponds to the upstream SDK option; the HTTP equivalent is the `Zoneless-Account` header. Neither function sends anything.

### Wallet reference checks

The request-draft builder requires an explicit account and wallet reference; it never falls back to an account's default wallet. The local seller ID, connected account ID, registered wallet ID, raw address, object type, Solana network, and USDC currency must agree. It accepts the upstream wallet statuses `new`, `validated`, and `verified` for planning, and rejects archived, failed, errored, missing, or unknown statuses. Upstream creates wallets with status `new`, not `active`.

These checks establish **local consistency only**. A caller can fabricate reference data. In a future live adapter, resolve the seller/account binding from an authenticated, tenant-scoped source, retrieve the wallet under that account, check current payout eligibility, and recheck authority immediately before any mutation. A wallet status or a local policy flag is not an approval receipt.

### Local example: build data, not a payment

The IDs and address below are syntax fixtures, not real seller or wallet onboarding evidence.

```typescript
import {
  buildSellerPayoutDraft,
  buildZonelessPayoutRequestDraft,
} from './agoragentic_zoneless_payouts.ts';

const input = {
  sellerId: 'seller-1',
  amountUsdc: '10.00',
  solanaWallet: '11111111111111111111111111111111',
  sourceReceipts: ['receipt-1'],
};

const internal = buildSellerPayoutDraft(input);
// internal.amount_atomic_units === '10000000'

const requestDraft = buildZonelessPayoutRequestDraft({
  ...input,
  connectedAccountId: 'acct_z_1Nv0FGQ9RKHgCVdK',
  walletReference: {
    seller_id: 'seller-1',
    id: 'wa_z_1Nv0FGQ9RKHgCVdK',
    account: 'acct_z_1Nv0FGQ9RKHgCVdK',
    wallet_address: input.solanaWallet,
    object: 'wallet',
    network: 'solana',
    currency: 'usdc',
    status: 'new',
  },
});
// requestDraft.body.amount === 1000
// requestDraft.body.destination === 'wa_z_1Nv0FGQ9RKHgCVdK'
// requestDraft.execution_authority === 'none'
// No HTTP request, signing, broadcast, or transfer occurs.
```

## Receipt drafts are not settlement evidence

`buildPayoutReceiptDraft()` emits schema `agoragentic.seller-payout-receipt-draft.v2` and `receipt_type: seller_payout_draft`. Every result has:

```json
{
  "execution_authority": "none",
  "evidence_source": "caller_supplied_unverified",
  "chain_verification": "not_performed",
  "settlement_confirmed": false
}
```

The default evidence mode is `simulated`. A completed local simulation can use `status: simulated`; it cannot carry an onchain transaction or claim `submitted`. An onchain submission record requires explicit `evidenceMode: onchain` and a syntactically valid 64-byte base58 signature. This is **only a caller-reported submission**, not proof that a transaction exists, succeeded, or became final. Address and signature validation is local syntax checking, not wallet ownership or cryptographic verification.

`confirmed`, upstream `paid`, and caller-supplied `settlementConfirmed: true` are rejected. This folder deliberately does not implement settlement verification, so it cannot produce a confirmed receipt. A simulated upstream `paid` response must not be promoted into real payment evidence. Source receipt IDs are references only; this helper does not retrieve or authenticate those receipts.

## Migration from the old reference

This is an intentional source-reference API correction, not a backwards-compatible live adapter release.

- `toZonelessPayoutRequest()` and `ZonelessPayoutRequest` are removed; no misleading compatibility alias remains. Use `buildSellerPayoutDraft()` for internal accounting or `buildZonelessPayoutRequestDraft()` with explicit wallet/account reference data for an offline upstream-shaped draft.
- Internal amounts and receipt drafts use `amount_atomic_units`, not an ambiguous API `amount` or the old receipt `amount_minor_units` field.
- Receipt drafts use the new schema/type above, require explicit onchain mode for submissions, and can no longer attest confirmation through a boolean.
- `body.metadata.source_receipts` is a JSON-encoded string array with `source_receipts_encoding: json`, not comma-separated text. Decode it with `JSON.parse()` to preserve IDs containing punctuation.

## Future production architecture (not implemented)

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

A transaction signature or broadcast response is **not** proof of settlement. `submitted` must remain distinct from `confirmed`. The offline helpers stop before the authenticated mutation and verification stages above.

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

## Files and verification

- `agoragentic_zoneless_payouts.ts` provides local policy checks, exact unit conversion, wallet-reference consistency checks, and non-authoritative draft builders.
- `../test/solana-payment-safety.test.mjs` covers the contract and existing no-funds demo. The existing `payment-contracts` CI job runs this file under Node 24; no additional workflow or service is needed.

From the repository root:

```bash
node --experimental-strip-types --test test/solana-payment-safety.test.mjs
node examples/agoragentic-growth/2026-06-21-solana-x402-paid-call-adapter-demo-mjs-c10944a6cc/solana_x402_paid_call_adapter_demo.mjs
```

With TypeScript available, run the focused strict type check:

```bash
tsc --noEmit --strict --target ES2022 --module nodenext --moduleResolution nodenext zoneless/agoragentic_zoneless_payouts.ts
```

Tests exercise local contract assertions, simulated/submitted separation, and rejection of fabricated confirmation. They do not execute the upstream Zod schema, contact a Zoneless deployment or blockchain, validate real account ownership, or qualify production settlement.

## Implementation notes

If this becomes platform code later, implement it as Agoragentic-native modules:

```text
server/modules/seller-payout-policy.js
server/modules/seller-payout-store.js
server/modules/solana-payout-adapter.js
server/modules/payout-receipt-builder.js
```

Do not import the whole Zoneless application into the Agoragentic API server. Production implementation must add trusted signing isolation, RPC confirmation policy, finality requirements, replay protection, webhook authentication, reconciliation, and operator approval receipts before any payout can become live. Verification must bind the transaction to the intended seller, recipient, amount, USDC mint, network/cluster, source receipts, and finality policy. Activation and any custody-freeze change require separate review; this reference is not an alternative path around those gates.

## References

- [Pinned upstream payout schema](https://github.com/zonelessdev/zoneless/blob/314414420494f63863015a060d231a7329b620e1/libs/shared-schemas/src/lib/PayoutSchema.ts)
- [Pinned upstream payout route and account header](https://github.com/zonelessdev/zoneless/blob/314414420494f63863015a060d231a7329b620e1/apps/api/src/routes/payouts.routes.ts)
- [Pinned external-wallet creation](https://github.com/zonelessdev/zoneless/blob/314414420494f63863015a060d231a7329b620e1/apps/api/src/modules/ExternalWallet.ts)
- [Pinned external-wallet status types](https://github.com/zonelessdev/zoneless/blob/314414420494f63863015a060d231a7329b620e1/libs/shared-types/src/lib/ExternalWallet.ts)
- [Pinned object ID generator](https://github.com/zonelessdev/zoneless/blob/314414420494f63863015a060d231a7329b620e1/apps/api/src/utils/IdGenerator.ts)
- [Zoneless payout API documentation](https://zoneless.com/docs/payouts)
- Agoragentic docs: https://agoragentic.com/docs.html
