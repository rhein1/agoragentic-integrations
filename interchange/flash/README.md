# Governed agent / Flash order-review candidate

A narrow, no-execution companion for the shared Runtime hackathon showcase. This does not add a trading strategy, general financial agent, wallet integration, or live-order route. It is not a replacement for Risk Fork or Interchange.

## Two deliberately separate paths

1. `governor.mjs` is a deterministic synthetic order-review lab. It uses **our own fixture schema**, not a fabricated Flash response. It illustrates owner ceilings, exact spent asset, recipient binding, quote freshness, permission withdrawal, excess allowances and price-protection trust requirements. Even a clean result is `review_ready_not_authorized`. No model inference, provider request, signature or order occurs.
2. `quote-only.mjs` is a separate default-off operator client for one documented Flash quote endpoint. It has no order-submission, signing, cancellation, approval or wallet-creation function. A provider observation does not upgrade the fixture to live trade protection.

## Offline tests and plan

Node 22+, no dependencies or credentials required:

```sh
node --test test/runtime-flash.test.mjs
node interchange/flash/quote-only.mjs plan
```

The tests use injected HTTP responses. Actual Flash credential issuance, provider response compatibility and host/network behavior remain untested. The new tests are loaded by the existing Interchange production-research gate; no workflow edit is required.

## Optional, separately approved quote observation

The endpoint is fixed to `POST https://flash.definitive.fi/v1/quote`. Before approving this operation, review the exact request plan and the provider's current API terms and quota implications. Quotes may consume provider quota even though no funds move. Supply a dedicated `FLASH_API_KEY` only through the operator's private environment. Never put it in the website, chat, repository, recording, logs or a downloadable configuration.

After separately authorizing exactly the quote-only operation, in PowerShell:

```powershell
$env:AGORA_FLASH_QUOTE_APPROVAL = 'owner-approved-quote-only'
node interchange/flash/quote-only.mjs quote buy 10 --live
Remove-Item Env:AGORA_FLASH_QUOTE_APPROVAL
```

No key example is included. The client expects the owner to provision `FLASH_API_KEY` privately. It uses fixed Base WETH/USDC market parameters, no funder address, no arbitrary URL/headers, no credential forwarding, no redirects and no automatic retry. Quantities are capped at 10 USDC for a buy or 0.01 WETH for a sell. These are quote-request caps, not authorization to trade. Flash documentation lists `funderAddress` as optional; whether this exact quote works for an actual account must still be qualified.

Only known response fields are projected. Setup, permit and order-signing payloads are deliberately not returned to the caller or executed. Reported output amounts are retained as strings with **amount-unit qualification required**; this client does not silently decide their units, compute a verified exchange rate or claim a slippage/allowance test against an uninterpreted provider response. Stop on unrecognized fields, authentication/payment challenges, redirection, oversize, timeout or substitution.

## Before any future execution adapter

Qualify the exact quote and setup schema, allowance/spender chain, signature-bound versus offchain terms, replay/partial-fill model, cancellation/revocation, and independently observed outcomes. Do not relabel the existing `provider_managed` contract, enable `personal_sign`, or accept unlimited approvals just to make a demo execute. The minimum-allowance flag alone does not establish compatibility with a no-infinite-allowance policy. Keep signing, submission, fill and settlement separate. No execution is authorized by this README.

## Source basis and remaining gaps

Official documentation inspected September 15, 2026:

- [Placing orders](https://flash.definitive.fi/docs/placing-orders): `buy` qty is contra asset spent; `sell` qty is target asset sold. Addresses identify assets, not just tickers.
- [Quote API](https://flash.definitive.fi/docs/api-reference/flash/quote): request shape, optional funder, quote and setup fields. Only the selected known subset is used; actual output-unit interpretation remains unqualified.
- [Minimal authorization](https://flash.definitive.fi/docs/minimal-authorization): `forceMinimalAllowance` does not remove the unlimited ERC20-to-Permit2 exception; multiple open orders affect required allowance. Do not rewrite provider setup payloads.

These sources document the provider, not this entry's qualification. Exact Flash Runtime judging/integration requirements and any permitted test environment still require organizer confirmation. The source may be reviewed on Windows; it does not inherit Dynamic's native-SDK requirements because it imports no wallet SDK. Root catalog promotion is intentionally deferred until evidence supports an integration claim.
