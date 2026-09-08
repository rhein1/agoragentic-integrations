# Anthropic Commerce Agents: no-money integration candidate

This augments Agoragentic's existing Claude integration with one bounded example:
read a synthetic listing, stage a title edit, block an unapproved apply, simulate
host approval, commit the exact change, and record local evidence. **Nothing here
connects to a merchant, starts a model, places an order, publishes a listing, or
moves funds.**

## Architecture and source ownership

```text
Anthropic shared MerchantToolExecutor (optional pinned source)
    -> upstream provenance + guardrails + host approval mark
    -> CommerceFixtureBackend
    -> FixtureStore apply-time scope/digest/expiry/revocation/version checks
    -> SQLite title + approval consumption + evidence in one transaction
    -> optional canonical Harness Core local proof/receipt composition
```

`upstream.json` is the single upstream revision holder. The reviewed reference is
`anthropics/commerce-agents` at `fd4d59224ab96b43c6dc6888207c67b3bd5a24cf`.
The integration imports it; it does not vendor, fork, or publish Anthropic's code.
Anthropic's reference is Apache-2.0 and describes itself as unmaintained. Agoragentic
owns compatibility testing for this adapter. No affiliation or endorsement is claimed.

The canonical policy, approval-artifact, lifecycle, and local receipt implementation
remains [Harness Core](https://github.com/rhein1/agoragentic-harness-core).
The SQLite approval rows are **synthetic test-host state**, not another production
policy engine or a replacement for Harness. `FixtureHost` is deliberately absent
from the merchant tool surface. A Harness review artifact is not a capability token
or authorization to execute against a live backend.

## Run the complete local fixture

From the integration repository root:

```bash
python claude-agent-sdk/commerce/demo.py
```

The demo uses an in-memory SQLite database and prints a redacted fixture-evidence
record. One synthetic title update must be committed, retries must leave the effect
count at one, and all production/payment/finality flags remain false. It does not
claim that an Anthropic runtime was exercised.

The underlying tests also cover SQLite reopening, competing apply retries,
revocation, exact approval expiry, policy revision changes, another merchant/
operator/session, stale records, changed proposal hashes, discard, and rollback
when the evidence write fails. All stored content is synthetic.

## Actual upstream shared-executor conformance

This is a separate gate, not part of the dependency-free tests. Create a trusted
local checkout of the upstream reference and check out the exact revision from
`upstream.json`. Keep it clean. In a dedicated virtual environment, install its
`commerce-common` and `merchant-agent/core` packages using their own metadata.
Dependency installation is an explicit development step, not demo runtime behavior.

```bash
python -m pip install /path/to/commerce-agents/commerce-common /path/to/commerce-agents/merchant-agent/core
python claude-agent-sdk/commerce/upstream_conformance.py --checkout /path/to/commerce-agents
```

The driver checks the Git revision, clean checkout, and reviewed boundary-file
blob identities before importing. It checks the actual import origins, then calls
the real `MerchantToolExecutor` through the fixture subclass. It does not replace
upstream provenance, guardrail, or approval checks. It also proves that an upstream
approval mark alone cannot bypass the fixture backend's separate apply gate.

Missing dependencies, wrong source, or failed checks exit with an error. There is
no mock fallback and no silent skip. The driver passed locally on September 8,
2026, including provenance, both approval gates, expiry, revocation, changed
requests, and current upstream guardrails. See [qualification evidence](QUALIFICATION.md).
Git checks are drift detection for a trusted developer checkout, not containment
of hostile filesystem/Git configuration or full dependency supply-chain assurance.

Even a passing driver qualifies only the shared executor + synthetic backend.
It does not qualify a Messages API model turn, Claude Agent SDK loop, Managed
Agents deployment, MCP transport, authenticated UI, live merchant, or payment path.
`qualified_runtimes` therefore starts empty.

## Compose with canonical Harness evidence

`harness-evidence.mjs` calls the existing Harness APIs; it does not contain a copied
policy/receipt engine. Its optional dependency is `agoragentic-harness-core@0.4.2`.
Install that exact dependency in an isolated development workspace using the
project's dependency-review process, then make it available to this module.

```bash
python claude-agent-sdk/commerce/demo.py > fixture-evidence.json
node claude-agent-sdk/commerce/harness-evidence.mjs fixture-evidence.json
```

The module checks the installed version, validates the no-money evidence boundary,
and creates a canonical local receipt with explicit `not_settlement_receipt` and
`self_reported_local_fixture` scope. It does not attest that another system executed
an action, and the JSON hash is not a signature. It emits no invented file-artifact
references. Its Harness policy mapping is advisory, not in-path enforcement.

The dependency-free JavaScript tests exercise evidence validation and cross-language
hash consistency. Actual composition against installed Harness Core 0.4.2 and its
exported proof/receipt schemas passes in `dependencies.test.mjs`.

## Deliberate limits

The backend accepts only the built-in synthetic store, not an arbitrary delegate
or URL. The only supported mutation is the fixture listing's title. Pricing,
inventory, campaigns, analytics, and SQL analysis fail as unavailable instead of
reporting fabricated metrics. The upstream record's zero price is a labeled fixture
value, not a quote or market-price claim. Credentials never enter the fixture.

Persistence and transaction guarantees apply only to this local SQLite fixture.
An external merchant write cannot be made atomic with this database by placing it
inside a Python transaction. A real connector needs authenticated principal
resolution, backend conditional writes/idempotency, a durable operation/outbox
protocol, evidence of the actual outcome, and reconciliation of unknown outcomes.
Do not automatically retry an external write after an uncertain response.

No browser approval UI, worker, webhook, external service, release activation,
settlement verifier, or live runtime has been added. Existing platform custody,
Risk Fork, MCP, and private ECF boundaries are unchanged.

See [CODEX_HANDOFF.md](CODEX_HANDOFF.md) for remaining implementation gates.
Primary contracts: [upstream backend guide](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/docs/backends.md),
[upstream safety matrix](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/docs/safety.md).
