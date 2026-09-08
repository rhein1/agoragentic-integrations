# Income work-pack: host integration handoff

## Outcome and authority

Build on the existing Agent OS deployment/work-pack path so an owner can understand which service work their agent could profitably perform, why it was proposed, what it would cost, and which funds are merely projected versus independently confirmed.

This change delivers an offline planner, a CLI, synthetic fixtures, and regression tests. It does **not** deliver online opportunity acquisition, an LLM worker, paid fulfillment, a signer, a withdrawal endpoint, deployment, or real revenue. Keep this distinction in every completion claim.

Keep platform custody frozen. Do not enable payments, create or fund wallets, sign transactions, publish listings/packages, deploy infrastructure, send outreach, or introduce a different payment path as a workaround. Do not ask for private keys or seed phrases in chat or repository files. A new repository, runtime, memory database, or orchestration service is out of scope.

## Inspect before wiring

Read the current repository instructions and source at the exact target heads; do not assume this handoff describes production. Trace the existing Agent OS work-pack/deployment, scheduler, seller-demand, public capability, quote/procurement, approval, receipt, and reconciliation paths. Check open PRs before duplicating work. Read the implementations and all relevant callers, not only the documentation.

The integrations repository's existing `agent-os/README.md` documents the public control-plane surface. `agent-os/agent_os_node.mjs` performs top-level CLI work and must not be imported as a library. Reuse an appropriate reviewed SDK or extract a side-effect-free client in a separate, scoped change, retaining existing tests.

## Next reviewable increment: read-only acquisition

Bind at most one source adapter to the existing host scheduler. Prefer owner-authorized inbound service orders; treat public catalog and seller-demand results as leads only. No inferred demand becomes an order. Define and test the normalized mapping into `agoragentic.income-preview-input.v1`; the fixture is the current contract, not a claim of compatibility with a hosted payload.

Enforce the source allowlist outside the model: exact permitted endpoints, bounded requests/response sizes and deadlines, rate/backoff limits, no arbitrary redirects or private-network destinations, and no ambient credentials forwarded to third parties. Load trusted time and the owner mandate from the host, never from fetched text. Use local fixtures to test this boundary before any network qualification. Do not run tests against third-party systems.

An optional model can classify/summarize candidates and propose estimates. It cannot modify limits, declare an order authorized, invent evidence, approve itself, select a new treasury destination, create tools, or activate a money-moving action. Bind its exact input/output artifacts to the existing run ledger. No LLM/provider calls are included in the current preview.

## Host persistence and evidence gates

The current work key is deterministic per mandate ID, source ID, and buyer-order reference. It is a proposal deduplication aid, not an exactly-once guarantee. Map cross-source duplicates to one canonical order in the host. Add a transactional unique key and compare-and-swap budget reservation in the existing persistence layer; prove concurrent runs and crash recovery cannot schedule or allocate twice. Do not introduce a second ledger/database here.

Before any future money movement, independently verify owner authorization and revocation, complete account/history coverage, asset/network/token contract, payer independence, quote/mandate/recipient/amount/expiry bindings, final settlement, accepted outcome, refunds/disputes, existing obligations, and cumulative budgets. Reference presence and self-hashes from this planner are insufficient. Unknown or stale evidence blocks the action. Use integer accounting and existing financial-contract validators rather than writing a second settlement implementation.

Keep buyer/seller identity proof, execution success, acceptance of the outcome, payment authorization, payment settlement, and actual external revenue as separate states. Never market a canary, an internal transfer, a pending receipt, or simulated profit as independent revenue.

## Later financial integration requires separate authorization

A live executor is a separately reviewed source change, not an environment toggle. Require fresh structured market availability, the existing custody/rail gates, explicit owner authorization and limits, a qualified external signer with narrowly scoped transaction policy, durable reservation/idempotency, and operational/security/accounting/legal review. None of that is granted by this PR.

An owner distribution must be an authenticated, expiring, replay-resistant request bound to the exact owner account, permitted destination, asset/network, amount, and fee budget. Reconcile pending withdrawal reservations before submitting anything; timeouts must not be blindly retried. Keep reserve preservation atomic with submission and reconciliation. Direct recovery of owner capital is distinct from earned-profit distribution.

## Verification and acceptance

Run:

```sh
node --check agent-os/income/planner.mjs
node --check agent-os/income/preview.mjs
node --test agent-os/income/planner.test.mjs
node agent-os/income/preview.mjs agent-os/income/fixture.json
node scripts/sync-integration-counts.mjs --check
node scripts/generate-repository-rename-preflight.mjs --check
node scripts/verify-doc-links.mjs
```

Also run the repository's existing integration-schema validation and relevant SDK/host suites. No new top-level integration, canonical tool ID, package, or discovery capability is introduced; do not increment catalog counts or advertise hosted support merely for this example.

For the read-only increment, acceptance requires a source-backed review displayed through an existing owner interface, complete rejection reasons, no network/secret authority inherited from content, no hosted writes or spending, and source/host observations clearly distinguished. For a later executor, additionally prove duplicate/repriced orders, concurrent reservations, expiry/revocation, stale authority, missing/tampered evidence, refunds, partial settlement, and crash recovery all fail closed in deterministic local tests.

Report exact files and commit IDs, test results, which host/worker/persistence/UI paths were exercised, and which remain unverified. Do not claim deployment, external adoption, self-sustaining income, or real transfers from an offline test result.
