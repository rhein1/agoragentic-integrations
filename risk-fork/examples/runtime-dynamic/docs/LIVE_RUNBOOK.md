# Owner-operated Dynamic testnet rehearsal

**This file authorizes nothing.** The real runner is disabled by default. The web page cannot invoke it. No credentials should be pasted into a chat, committed, logged, uploaded with the presentation, or supplied to the preparation process.

## Why preparation and payment are different processes

The Risk Fork local-reference adapter is a protocol implementation, not a qualified kernel isolation boundary. `prepare.mjs` runs only synthetic company data and bounded built-in operations. It receives no signing credentials. Its child copies are destroyed and checked before that process ends.

Only then may a trusted operator run the separate signing process against a dedicated test wallet. The authority comes from the owner's exact expiring approval, not from an untrusted child or a claim of production containment. Do not use this arrangement with customer data, arbitrary remote tools, untrusted executable code, or a production wallet.

## Prerequisites

- Owner-reviewed PR head; ordinary and new hosted tests pass. Record the exact run URL/head after actually checking the logs. The runner's local CI fields are an **operator attestation**, not a GitHub API verifier.
- Linux x64/arm64 or supported macOS Node runtime. Native Windows/edge environments are not the documented Dynamic server-wallet target. Windows owners should use an appropriately secured Linux environment/WSL, not assume native SDK compatibility.
- A candidate `live/package-lock.json` is checked in. Its dependency audit currently reports zero advisories, but npm 11 `npm ls --all` exits with `ELSPROBLEMS` for the installed tree; this is not yet a merge-ready or qualified install. Resolve that tree issue first, then review package provenance, native-addon behavior, and a credential-free import test on a supported OS. Do not use credentials before those checks pass.
- Dedicated Dynamic Server Wallet and a separately approved seller EOA on Base Sepolia. Creating/funding accounts is a separate owner step. Test ETH and gas are required; there is no faucet/auto-funding command.
- Secret bundle from the owner's vault, outside the checkout, with owner-only file permissions. The 0.0.225 example API uses `environment_id`, `api_token`, `account_address`, `external_server_key_shares`, and optional `password`. Never use an existing production key. Do not rename this model `provider_managed`.
- A private state directory outside the checkout, mode 0700. Preserve it across retries and restarts. Do not delete a claim merely to make a command run again.

## 1. Prepare without credentials

From the repository root, with no DYNAMIC_/WALLET_ credential environment variables:

```sh
node risk-fork/examples/runtime-dynamic/prepare.mjs current 6 attack /ABSOLUTE/PRIVATE/runtime-plan.json
```

Inspect the task, chosen provider, budget, taint rejection, cleanup evidence, and plan hash. Free-source and refused plans need no wallet action. Preparation expires after five minutes: perform it after setup, not hours before the demo.

## 2. Explicit owner approval

Copy `live/approval.example.json` outside the repository. Fill in the dedicated wallet, fixed seller, exact plan hash, a short UTC expiry, verified CI run and reviewed head. Keep the caps at or below the example. Change `approved` to true only after reviewing the exact action. This approval grants at most one attempt for that plan; it is not a reusable spending mandate.

Per action the code caps native test-token value at 0.00001 ETH, gas at 21,000, max fee at 2 gwei, and approved worst-case total at 0.0001 ETH. The template is narrower. No arbitrary contract calldata or token allowances are supported. The seller must be an EOA at preflight. All economics are testnet demonstration economics, not actual data-market prices.

## 3. One separately authorized live attempt

```sh
RUNTIME_DYNAMIC_LIVE=owner-approved-base-sepolia-demo \
node risk-fork/examples/runtime-dynamic/live/run.mjs \
  /ABSOLUTE/PRIVATE/runtime-plan.json \
  /ABSOLUTE/PRIVATE/runtime-approval.json \
  /ABSOLUTE/PRIVATE/dynamic-secret.json \
  /ABSOLUTE/PRIVATE/runtime-state
```

The runner creates a durable exclusive attempt claim **before** loading credentials or contacting Dynamic. It verifies chain identity, seller type and nonce; rechecks current approval immediately before signing and before broadcast; parses the signed transaction and checks exact sender, recipient, network, value, nonce, calldata, and fee limits; then broadcasts only once. It polls read-only receipt/transaction state to verify success and at least two confirmations.

No completed testnet transfer is claimed without observed evidence. No mainnet, key export, wallet creation, token approval, signature printout, generic RPC forwarding, or public wallet endpoint exists.

## 4. Reconcile; never blindly retry

A timeout can occur after signing or broadcasting. It does not cancel the provider. `reconciliation_required` means preserve the claim, inspect the recorded transaction hash if known, and reconcile with provider/RPC records. Do not create a new nonce or re-sign because an HTTP response was missing. A pre-dispatch failure after a claim also requires operator review before any new authorization.

Retained evidence is under the exact private state directory. Share only a reviewed redacted receipt; raw transaction signatures, secret bundles, access tokens, and key shares never belong in the public demo. The browser currently replays its own no-money run, not arbitrary uploaded proof. A hash/receipt alone does not prove that a claimed external event happened.

## Deployment

For a shareable **browser-only rehearsal**, publish only `risk-fork/examples/runtime-dynamic/public/` through a static host. Do not publish `live/`, `.env`, operator plans, approvals, state, node_modules, or secret files. Netlify config is included in this example. The connected Netlify account had no projects when checked. Creating a new public rehearsal project requires owner confirmation; no deployment is claimed.

The real Risk Fork demonstration is a local Node app. Keep it loopback-only. Publishing a multi-user runtime needs separate authentication, concurrency, service supervision, abuse, isolation and deployment review; do not change the bind host to make it a public wallet service.
