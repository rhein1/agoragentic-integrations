# Anchor Safe Pay + Harness Core reference

This is a **default-off, fixture-only, no-money reference adapter**. It demonstrates one narrow composition:

> Safe Pay supplies recipient-risk evidence. Caller-declared fixture records supply an unverified mandate and approval. The adapter permits only a labeled simulation; none of those records verifies owner authority or moves money.

The adapter is not a new risk engine, payment product, wallet, settlement rail, hosted service, or production Safe Pay client. It does not fork Safe Pay, call its paid endpoint, use a key, touch a wallet, or imply a partnership with its maintainer.

## What it proves

```text
caller-declared, unverified local mandate
  -> exact proposed x402 payment binding
  -> exact, expiring caller-declared approval record
  -> per-action and cumulative authorization limits
  -> Safe Pay screenAllows contract over an in-memory fixture
  -> allow / ask / deny
  -> one adapter-owned inert simulator
  -> bounded local receipt with funds_moved: false
```

The critical rule is enforced in code:

```text
Safe Pay allow != owner payment authority
risk allow != spend approval
simulator invocation != settlement proof
local receipt != payment or outcome proof
caller declaration != verified owner authority
fixture allow != authorization for external effects
```

Safe Pay v0.3.0 is responsible only for the recipient-risk verdict. This adapter canonicalizes and integrity-binds the principal, agent, recipient, amount, asset, network, task hash, quote hash, idempotency-key hash, timestamps, mandate, approval, and budget state. Integrity binding is not authentication: this fixture has no owner signature or host-attested authority verifier.

Harness Core v0.4.2 supplies its public authority-boundary, sanitization, stable-hash, and stable-ID primitives. Exact record matching, expiry, one-use consumption, and cumulative atomic-unit reservation are deliberately implemented by this adapter because Harness Core does not currently claim those payment-specific controls.

Every receipt therefore reports `owner_authority_verified: false`, `approval_verified: false`, and `decision_scope: "caller_declared_fixture_simulation_only"`. An `allow` decision means only that the adapter-owned inert simulator passed the local checks. It grants no authority for a wallet, network request, payment, or other external effect.

## Run it

Node 20 or newer is required.

```bash
cd anchor-safe-pay
npm ci
npm test
npm run example
```

`npm run example` uses only checked-in JSON fixtures, an in-memory fetch implementation owned by `createFixtureSafePayScreenAdapter`, and an inert simulator owned by `createFixtureSimulatedSend`. The screening helper closes over the pinned Safe Pay export, rejects function injection, and requires that export to use its internal fake fetch exactly once. The simulator accepts no caller callback and cannot call a wallet, provider, or transport. The production `https://api.anchor-x402.com/v1/screen` endpoint is never contacted. The simulator returns:

```json
{
  "status": "simulated",
  "funds_moved": false,
  "settlement_proven": false
}
```

The example uses a fixed fixture clock so it remains deterministic. Its timestamps are scenario data, not current runtime evidence.

## Why it does not call `guardedSend`

Safe Pay's `guardedSend` correctly runs a caller thunk after its own risk policy permits the recipient. This reference deliberately does not expose that path: it needs exact caller-declared mandate and approval matching, expiry, action binding, cumulative budget, idempotency, and one-use reservation without granting any caller code an execution hook. It therefore uses Safe Pay's pre-payment decision surface, `screenAllows`, then invokes only the adapter-owned inert simulator after every local gate passes.

The wrapper pins Safe Pay's fail-closed options (`blockOn: ["block", "review"]`, `onError: "block"`). A `review` result becomes `ask`; it is never silently treated as `allow`. A partial `allow` is also held. Unknown, malformed, stale, future-dated, mismatched-recipient, or unavailable evidence is denied.

## Public API

```js
import {
  InMemorySafePayLedger,
  buildActionBinding,
  buildMandateBinding,
  createAnchorSafePayHarness,
  createFixtureSafePayScreenAdapter,
  createFixtureSimulatedSend,
} from './safe-pay-harness-adapter.js';
```

- `buildActionBinding(action)` canonicalizes and hashes the exact action. It never returns the raw idempotency key.
- `buildMandateBinding(mandate)` canonicalizes and hashes every caller-declared mandate policy field so an approval can bind the exact content. It does not verify the caller or owner.
- `createFixtureSafePayScreenAdapter({ verdict, unavailable?, fixtureDelayMs? })` exercises the pinned Safe Pay contract with an internal fake fetch and zero network calls. It does not accept an injected screening function; the bounded delay exists only to exercise local timeout behavior.
- `createFixtureSimulatedSend(outcome?, fixtureDelayMs?)` creates an adapter-owned inert simulator. It accepts only primitive configuration, never invokes caller code, a wallet, a provider, or a transport, and defaults to a deterministic success. The bounded non-default arguments exist only to exercise local timeout and ambiguity branches in hermetic tests.
- `createAnchorSafePayHarness({ enabled, ledger?, fixtureNow?, fixtureChallengeNow?, ... })` returns `governedSend(...)`. Omitted `enabled` is false. Fixture clocks are primitive ISO timestamp data; caller clock callbacks are rejected.
- `InMemorySafePayLedger` atomically consumes an idempotency-key hash and approval reference before simulator invocation, retains ambiguous reservations, keys cumulative counters by the mandate, principal, agent, asset, and network budget domain, and pins every used `mandate_ref` to its first exact mandate hash. Its public snapshot is read-only; preflight, reservation, and finalization require a module-private harness capability, so retaining the instance does not grant a caller a mutation hook.

The ledger is intentionally process-local. It proves the state machine but is **not** durable across restarts and is not a cross-process or distributed lock. Raw atomic amounts are never summed across different assets or networks: each cumulative counter is isolated by a recorded budget-scope hash over mandate, principal, agent, asset, and network. Reusing a used mandate reference with changed scope or limits is denied; an intentional policy revision needs a new reference and, outside this fixture, independent authorization plus explicit budget-lineage semantics. A production adapter would need a separately reviewed authority verifier and durable transactional store; this source provides neither.

This module is **not a same-process isolation boundary**. It removes documented caller execution hooks and captures the intrinsics used for fixture branding, but it still assumes an intact JavaScript realm and trusted host process. Hostile code that can alter platform globals before module initialization already controls the process and is outside this fixture's protection claim.

## Decision table

| Case | Decision | Simulator |
|---|---|---|
| Safe Pay `allow`, exact caller-declared mandate and approval hashes | `allow` in fixture scope only | runs once in simulation |
| Missing principal authority | `deny` | never runs |
| Safe Pay `review` | `ask` | never runs |
| Safe Pay `block` | `deny` | never runs |
| Safe Pay unavailable or unknown | `deny` | never runs |
| Safe Pay `allow` with `partial: true` | `ask` | never runs |
| Per-action or cumulative cap exceeded | `deny` | never runs |
| Approval not bound to the exact mandate hash | `deny` | never runs |
| Used mandate reference redefined with changed policy | `deny` | never runs |
| Recipient, amount, asset, or network changed after approval | `deny` | never runs |
| Approval expired | `deny` | never runs |
| Duplicate idempotency key | `deny` | no second simulator invocation |
| Stale verdict | `deny` | never runs |
| Inert simulator throws, times out, or returns a non-simulation result | `ask` / ambiguous | key and budget stay reserved; no automatic retry |

The test suite covers every row, including a concurrent replay race.

## Receipt boundary

The returned `agoragentic.anchor-safe-pay.local-receipt.v1` record includes:

- principal and agent references;
- normalized recipient, exact atomic amount, asset, and network;
- task, quote, action, and idempotency-key hashes;
- mandate and approval references, exact cross-binding hashes, timestamps, expiry, match state, and explicit caller-declared/unverified status;
- per-action and cumulative authorization state, including the exact budget-scope hash;
- a bounded normalized Safe Pay verdict hash and exact screen-context hash;
- one composite receipt-binding hash over the action, mandate, approval, Safe Pay evidence, budget scope and state, reservation, final decision, and simulator state;
- inert-simulator invocation and ambiguity state; and
- explicit `owner_authority_verified: false`, `approval_verified: false`, `authorized_for_external_effects: false`, `funds_moved: false`, `settlement_proven: false`, and `outcome_verified: false` boundaries.

Returned receipts and their nested evidence are deeply immutable. The ledger retains only the primitive receipt ID needed for replay evidence, not the caller-visible receipt object. The raw Safe Pay verdict, notes, signal detail, raw idempotency key, wallet material, credentials, and simulator result are not retained. The locally computed Safe Pay hash is an integrity binding over bounded fixture evidence; it is not a provider signature, attestation, sanctions certification, or proof of live screening.

## Upstream pins and relationship boundary

- Safe Pay: [`hypeprinter007-stack/anchor-x402-safe-pay`](https://github.com/hypeprinter007-stack/anchor-x402-safe-pay) v0.3.0 at `1cf112758b58f43e0def20d558910822e6183487` (MIT).
- Harness Core: [`rhein1/agoragentic-harness-core`](https://github.com/rhein1/agoragentic-harness-core) v0.4.2 at `d858f955023df8094855e36ca23d8399d9460000` (Apache-2.0).
- Exact local provenance: [`upstream-provenance.json`](./upstream-provenance.json).

No Safe Pay source is copied. No collaboration, endorsement, certification, or partnership is claimed. A new external issue or maintainer contact remains deferred until explicit agreement to collaborate exists.

The later success criterion is an independently operated keep/remove evaluation in the real Safe Pay repository—not that this self-test passes. Any production endpoint, real wallet, durable ledger, live payment hook, or external-effect canary requires a separate design and explicit owner authorization.
