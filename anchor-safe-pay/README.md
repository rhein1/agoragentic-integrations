# Anchor Safe Pay + Harness Core reference

This is a **default-off, fixture-only, no-money reference adapter**. It demonstrates one narrow composition:

> Safe Pay supplies recipient-risk evidence. Harness policy supplies owner authority for one exact action. Neither result moves money.

The adapter is not a new risk engine, payment product, wallet, settlement rail, hosted service, or production Safe Pay client. It does not fork Safe Pay, call its paid endpoint, use a key, touch a wallet, or imply a partnership with its maintainer.

## What it proves

```text
caller-supplied local owner mandate
  -> exact proposed x402 payment binding
  -> exact, expiring owner approval
  -> per-action and cumulative authorization limits
  -> Safe Pay screenAllows contract over an in-memory fixture
  -> allow / ask / deny
  -> one caller-owned simulated callback
  -> bounded local receipt with funds_moved: false
```

The critical rule is enforced in code:

```text
Safe Pay allow != owner payment authority
risk allow != spend approval
callback invocation != settlement proof
local receipt != payment or outcome proof
```

Safe Pay v0.3.0 is responsible only for the recipient-risk verdict. This adapter independently binds principal, agent, recipient, amount, asset, network, task hash, quote hash, idempotency-key hash, timestamps, mandate, approval, and budget state.

Harness Core v0.4.2 supplies its public authority-boundary, sanitization, stable-hash, and stable-ID primitives. Exact payment approvals, expiry, one-use consumption, and cumulative atomic-unit reservation are deliberately implemented by this adapter because Harness Core does not currently claim those payment-specific controls.

## Run it

Node 20 or newer is required.

```bash
cd anchor-safe-pay
npm ci
npm test
npm run example
```

`npm run example` uses only checked-in JSON fixtures and an in-memory fetch implementation owned by `createFixtureSafePayScreenAdapter`. The helper closes over the pinned Safe Pay export, rejects function injection, and requires that export to use its internal fake fetch exactly once. The production `https://api.anchor-x402.com/v1/screen` endpoint is never contacted. The simulated callback returns:

```json
{
  "status": "simulated",
  "funds_moved": false,
  "settlement_proven": false
}
```

The example uses a fixed fixture clock so it remains deterministic. Its timestamps are scenario data, not current runtime evidence.

## Why it does not call `guardedSend`

Safe Pay's `guardedSend` correctly runs a caller thunk after its own risk policy permits the recipient. This reference needs additional gates before that thunk: exact owner authority, approval expiry, action binding, cumulative budget, idempotency, and one-use reservation. It therefore uses Safe Pay's pre-payment decision surface, `screenAllows`, then invokes the simulated callback only after every local gate passes.

The wrapper pins Safe Pay's fail-closed options (`blockOn: ["block", "review"]`, `onError: "block"`). A `review` result becomes `ask`; it is never silently treated as `allow`. A partial `allow` is also held. Unknown, malformed, stale, future-dated, mismatched-recipient, or unavailable evidence is denied.

## Public API

```js
import {
  InMemorySafePayLedger,
  buildActionBinding,
  createAnchorSafePayHarness,
  createFixtureSafePayScreenAdapter,
  createFixtureSimulatedSend,
} from './safe-pay-harness-adapter.js';
```

- `buildActionBinding(action)` canonicalizes and hashes the exact action. It never returns the raw idempotency key.
- `createFixtureSafePayScreenAdapter({ verdict, unavailable?, fixtureDelayMs? })` exercises the pinned Safe Pay contract with an internal fake fetch and zero network calls. It does not accept an injected screening function; the bounded delay exists only to exercise local timeout behavior.
- `createFixtureSimulatedSend(callback)` explicitly marks a caller-owned callback as fixture simulation. The marker is a declaration, not a security sandbox; the caller remains responsible for keeping that callback free of network, wallet, and other external effects.
- `createAnchorSafePayHarness({ enabled, ledger?, now?, ... })` returns `governedSend(...)`. Omitted `enabled` is false.
- `InMemorySafePayLedger` atomically consumes an idempotency-key hash and approval reference before callback invocation, retains ambiguous reservations, and keys cumulative counters by the mandate, principal, agent, asset, and network budget domain.

The ledger is intentionally process-local. It proves the state machine but is **not** durable across restarts and is not a cross-process or distributed lock. Raw atomic amounts are never summed across different assets or networks: each cumulative counter is isolated by a recorded budget-scope hash over mandate, principal, agent, asset, and network. A production adapter would need a separately reviewed durable transactional store and a new authority review; this source provides no production mode.

## Decision table

| Case | Decision | Callback |
|---|---|---|
| Safe Pay `allow`, exact mandate and approval | `allow` | runs once in simulation |
| Missing principal authority | `deny` | never runs |
| Safe Pay `review` | `ask` | never runs |
| Safe Pay `block` | `deny` | never runs |
| Safe Pay unavailable or unknown | `deny` | never runs |
| Safe Pay `allow` with `partial: true` | `ask` | never runs |
| Per-action or cumulative cap exceeded | `deny` | never runs |
| Recipient, amount, asset, or network changed after approval | `deny` | never runs |
| Approval expired | `deny` | never runs |
| Duplicate idempotency key | `deny` | no second callback |
| Stale verdict | `deny` | never runs |
| Callback throws, times out, or returns a non-simulation result | `ask` / ambiguous | key and budget stay reserved; no automatic retry |

The test suite covers every row, including a concurrent replay race.

## Receipt boundary

The returned `agoragentic.anchor-safe-pay.local-receipt.v1` record includes:

- principal and agent references;
- normalized recipient, exact atomic amount, asset, and network;
- task, quote, action, and idempotency-key hashes;
- mandate and approval references, hashes, timestamps, expiry, and match state;
- per-action and cumulative authorization state, including the exact budget-scope hash;
- a bounded normalized Safe Pay verdict hash and exact screen-context hash;
- one composite receipt-binding hash over the action, mandate, approval, Safe Pay evidence, budget scope and state, reservation, final decision, and callback state;
- callback invocation and ambiguity state; and
- explicit `funds_moved: false`, `settlement_proven: false`, and `outcome_verified: false` boundaries.

The raw Safe Pay verdict, notes, signal detail, raw idempotency key, wallet material, credentials, and callback result are not retained. The locally computed Safe Pay hash is an integrity binding over bounded fixture evidence; it is not a provider signature, attestation, sanctions certification, or proof of live screening.

## Upstream pins and relationship boundary

- Safe Pay: [`hypeprinter007-stack/anchor-x402-safe-pay`](https://github.com/hypeprinter007-stack/anchor-x402-safe-pay) v0.3.0 at `1cf112758b58f43e0def20d558910822e6183487` (MIT).
- Harness Core: [`rhein1/agoragentic-harness-core`](https://github.com/rhein1/agoragentic-harness-core) v0.4.2 at `d858f955023df8094855e36ca23d8399d9460000` (Apache-2.0).
- Exact local provenance: [`upstream-provenance.json`](./upstream-provenance.json).

No Safe Pay source is copied. No collaboration, endorsement, certification, or partnership is claimed. A new external issue or maintainer contact remains deferred until explicit agreement to collaborate exists.

The later success criterion is an independently operated keep/remove evaluation in the real Safe Pay repository—not that this self-test passes. Any production endpoint, real wallet, durable ledger, live payment hook, or external-effect canary requires a separate design and explicit owner authorization.
