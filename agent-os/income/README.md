# Income work-pack preview

**Status: source-only, offline, non-executable. This is not a deployed autonomous income agent.**

This example is part of the existing Triptych OS (Agent OS) integration. It turns the idea of an agent that earns, pays its operating costs, and returns surplus to its owner into a testable planning contract. It does not create another runtime, memory database, wallet, or marketplace. No new integration/tool ID, npm package, or hosted API is introduced.

The implemented wedge is **service revenue**, not speculative trading. A qualified agent would find an actual buyer order for a capability it can deliver, estimate all-in costs, obtain authorization through the existing host, complete the work, reconcile independent outcome and settlement evidence, and only then consider a distribution. The planner implements the review arithmetic and proposal boundary, not those live integrations.

## Run locally

Node.js 20 or newer; no dependency installation, API key, wallet seed, or network connection is required.

```sh
node --test agent-os/income/planner.test.mjs
node agent-os/income/preview.mjs agent-os/income/fixture.json
```

The fixture is synthetic and uses a fixed historical clock. It produces two review-only proposals, 5.000000 USDC of proposed cost, 15.300000 USDC of expected net contribution, and a 15.000000 USDC surplus preview. Its 10 USDC owner request is economically feasible within that fixture, but `authorized` is false and `transferred_usdc` is zero. These figures are not Agoragentic revenue, pricing, expected investment returns, or evidence of external demand.

For a local export, use the same JSON shape as `fixture.json`, set `evidence_class` to `unverified_owner_export`, and supply complete, reconciled history and an explicit clock. This module does not fetch or authenticate that export. Never place credentials or raw private task content in a snapshot. Input is limited to 512 KiB in the CLI and 500 items per collection in the planner. Unknown or missing fields fail closed.

## Implemented behavior

`planIncomeCycle(snapshot)` is pure JSON-in/JSON-out. It validates an explicit, unexpired, non-revoked mandate; checks approved source and capability IDs; rejects unsupported strategies and orders without buyer/scope references; rejects expired or stale observations; and ranks remaining service orders by expected net contribution. Ranking is deterministic and greedy, not a globally optimal capital allocator.

Each proposal includes a stable work key, a terms hash binding the full mandate and opportunity, the input hash, references, expiry, expected contribution, and worst-case cost. A host can pass previously reserved/completed work keys to avoid recommending the same buyer order again. This is **not durable idempotency**: this module creates no database, reserves nothing, and cannot prevent concurrent hosts from acting. Host-side transactional uniqueness and reservation are required before any future executor is connected.

All monetary inputs are unsigned decimal strings with at most six fractional digits. Arithmetic uses integer micro-units, never floating point. This version accepts only the explicit USDC / `eip155:8453` accounting label. It neither validates a token contract nor builds a blockchain transaction.

```text
expected_net = floor(gross_revenue * success_probability_bps / 10000)
               - inference - tools - gas - platform - delivery - risk_allowance

cash_capacity = max(0, supplied_balance - pending_debit_holds
                    - external_holds - operating_reserve
                    - refund_reserve - principal_floor)

profit_capacity = max(0, eligible_external_revenue_from_input
                      - settled_costs - settled_refunds - prior_owner_distributions
                      - pending_debit_holds - external_holds)

surplus_preview = min(max(0, cash_capacity - proposed_cost),
                      max(0, profit_capacity - proposed_cost))
```

Costs are required estimates including failure/retry exposure; success probability is an input assumption, not a calibrated model output. No fee schedule or investment-return assumption is inferred. The planner never adds expected job proceeds to available cash.

## Accounting contract and its limits

A settled external-revenue row contributes to the input projection only when both settlement and outcome references are present. Pending, failed, disputed, capital, internal-transfer, and test-revenue rows do not count as earned revenue. Pending/disputed outgoing costs, refunds, and owner distributions become cash holds. Settled costs/refunds reduce projected profit. Duplicate ledger IDs or settlement component references invalidate the snapshot, rather than being silently dropped.

`settlement_ref` is a unique ledger/settlement-component reference, not necessarily a transaction hash: several economically distinct components of one transaction need distinct references after host reconciliation. `external_holds_usdc` covers obligations **not already represented** by pending/disputed debit rows. The supplied balance must be posted cash, not pending credits. `history_complete: true` is only a caller assertion: this module cannot verify coverage, reconcile the balance to history, identify undisclosed liabilities, establish payer independence, verify signatures, or confirm blockchain finality.

Outstanding pending/disputed debits and external holds conservatively reserve both cash and projected earnings. This prevents a large capital balance from making already-committed earnings appear available for another distribution. External holds may over-reserve earnings; this preview does not infer which obligations could be funded from capital.

Accordingly, the output always carries `evidence_verified: false`, an explicit warning, and `actual_revenue_verified_usdc: null`. A plausible reference, a self-hash, or the word `settled` is not payment proof. Do not use these projections as the sole basis for moving money.

Owner requests are amount/expiry/recipient checks only. The recipient is compared with the mandate's configured address. The module authenticates neither the owner nor the mandate; it does not sign, broadcast, reserve funds, or execute a withdrawal. Actual capital-return requests require a separate owner-authorized workflow; this preview considers only surplus distributions.

## Authority boundary

`execution_enabled`, `transfers_enabled`, `signing_enabled`, and `network_enabled` are always false. `executeIncomeAction()` always throws. There is no live mode and environment variables such as `AGORAGENTIC_EXECUTE=true` cannot enable it. A later source change and a separately reviewed host boundary would be necessary.

The existing platform custody freeze is not changed or bypassed. The public market status observed on September 7, 2026 reported `platform_custody_frozen`, with paid execution, settlement, and managed-wallet provisioning unavailable. Future activation must consult fresh structured authority and independent owner approval; this dated observation is not an activation rule.

No arbitrary web crawling, scraping, outreach, vulnerability testing, trading, staking, yield routing, token approvals, signing, publication, or paid execution is implemented. Website/API responses must remain untrusted data, not policy or signer instructions. Listing catalog prices and seller-demand signals are not buyer orders or proof that anyone will pay.

## Existing integration points

Use the [Agent OS control-plane documentation](../README.md) for the existing account, quote, procurement, approval, job, and reconciliation interfaces. The existing `agent_os_node.mjs` is a CLI with top-level behavior, not a side-effect-free library to import into this planner. This example deliberately does not import it.

Use the [Harness Core boundary](../../harness-core/README.md) for existing local proposal/receipt responsibilities. The hosted runtime remains responsible for scheduling and execution; existing Memory/ECF components retain their own responsibilities. The [Codex handoff](CODEX_HANDOFF.md) specifies the missing wiring and acceptance gates without granting production or financial authority.
