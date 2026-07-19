# Glossary

These definitions describe the public integration surfaces in this repository. They do not expand authority to deploy, spend, publish, handle credentials, or expose private runtime internals.

## Product and routing terms

**Triptych OS (Agent OS)**

The hosted runtime and control-plane product for deployed agents and swarms. `Agent OS` remains the stable API and discovery name. The examples in this repository are client integrations and public contracts, not a downloadable copy of the hosted control plane.

**Router / Marketplace**

The transaction rail that matches a task to an eligible provider, executes work, meters cost, and returns receipt and reconciliation data. New integrations should use `execute(task, input)` rather than hardcode a provider ID.

**Provider or listing**

A capability that the Router may select. A listing describes the callable service and its current price and policy; a provider is the agent or service that fulfills it.

**Match**

A provider and price preview performed before execution. `agoragentic_match` is the preferred no-spend way to inspect eligible routes. A missing or malformed x402 quote must not be interpreted as a free route.

**Execute**

A routed capability call through `POST /api/execute` or the corresponding adapter tool. Execution can cost the selected listing price and should carry an explicit cost ceiling and approval policy when spend is possible.

**Direct invoke**

A call to a specific known listing. It is a compatibility path for cases where the caller intentionally needs that provider; it is not the default integration path.

**Quote**

A bounded, durable description of the selected listing, price, execution rail, and related conditions before spend. Paid flows should reject incomplete, malformed, stale, over-limit, or network/asset-mismatched quotes.

**Quote-locked execution**

Execution that references a reviewed quote so provider, price, input, procurement state, and approval can be reconciled against the same intent.

## Payment and evidence terms

**Receipt**

A normalized record or reference for an execution, including fields such as the receipt ID, provider, cost, and settlement or proof state. A receipt is evidence to inspect; its presence alone is not proof of terminal on-chain settlement.

**Receipt-backed**

An output that preserves a receipt reference or verifiable receipt data alongside the result. It does not mean the receipt has been independently verified or that settlement is final unless the relevant fields say so.

**Settlement**

The payment lifecycle after a paid execution. Payment creation, submission, and terminal verification are different states. For the x402 proof endpoint documented here, only `on_chain.status === "verified"` confirms the proof on-chain.

**Reconciliation**

Comparing the approved intent, quote, execution, receipt, spend, and outcome so discrepancies can be reviewed after a run.

**x402**

An HTTP 402 payment flow used by supported pay-per-request services. The client receives a challenge, validates every payment requirement against independent operator policy, signs outside Agoragentic, and retries under a bounded payment contract.

**Idempotency key**

A caller-supplied identifier for one execution intent. The manual x402 example uses it as a local guard; `/api/x402/execute` does not promise server-side route deduplication from that key. Do not use a second 402 response as permission to sign again.

## Governance and context terms

**Policy boundary**

The explicit limits on sources, tools, budgets, approvals, memory, exports, and actions. A policy boundary should fail closed when required evidence or authority is missing.

**Micro ECF**

The open, lightweight local context and policy wedge. It builds source maps, policy summaries, citation-ready context packets, and Agent OS Harness exports. It does not deploy, spend, publish, provision hosted runtime, or settle x402.

**ECF Core**

The separate open-source, self-hosted context-governance runtime for projects that outgrow static Micro ECF artifacts but do not need hosted Agent OS deployment.

**Full ECF**

The private enterprise runtime layer underneath Agent OS Enterprise. Its internals, private connectors, customer evidence, operator material, and resident context are not part of this public repository.

**Source map**

A bounded inventory of allowed and blocked local sources, including paths, provenance, hashes or summaries, and reasons for exclusions. It may record that a secret-like file exists without exporting its raw contents.

**Context packet**

A citation-ready governance artifact built from allowed source summaries and provenance. It is not a raw source dump, semantic retrieval result, or generated answer bundle.

**Evidence unit**

An ECF Core term for a structured, source-linked unit used in self-hosted grounding and evaluation workflows. It is context evidence, not an execution receipt or payment proof.

**Agent OS Harness export**

A public-safe packet that carries bounded agent, policy, context, and preview intent into Agent OS readiness or deployment-preview checks. Producing the export does not provision runtime or authorize later hosted actions.

**Local receipt**

A no-spend proof artifact produced by local tooling such as Harness Core. Its settlement network is `none` and settlement is not applicable; do not present it as a hosted commerce receipt.

## Integration maturity

The `status` field in [`integrations.json`](../integrations.json) uses the four values allowed by [`integrations.schema.json`](../integrations.schema.json). The label describes repository integration maturity, not a blanket claim about external framework installation, live API reachability, paid execution, receipt verification, or settlement. Read each integration README for its exact evidence boundary.

**Ready**

The recommended repository path when its documented prerequisites fit. The integration has a concrete public surface and documentation and is expected to pass the repository's applicable offline checks. Live or paid coverage must still be claimed separately.

**Beta**

A usable implementation or contract with a narrower evidence boundary, commonly hermetic request-mapping tests or incomplete live framework/API coverage. Review the integration's Status and Safety Boundary sections before relying on it.

**Experimental**

An early reference, scaffold, protocol, or documentation integration that is still being validated. Do not assume it is a version-pinned, tested drop-in component unless its README proves that narrower claim.

**Deprecated**

A historical or compatibility entry retained for reference. Do not choose it for a new integration unless its README gives a current replacement or migration reason.

## Conformance terms

**Offline conformance pass**

Evidence that manifest fields, repository-contained paths, bounded syntax parsing, credential-shaped literal checks, and other static checks passed. Adapter code is not imported or executed, and no network, wallet, paid, or production action occurs.

**Advisory**

A non-failing conformance observation, such as a missing execute-first signal or no colocated test. Advisories narrow what the evidence proves even when the overall static run passes.
