# run.pay offline evidence importer

Source-only extension of `@agoragentic/transaction-assurance`, not another
product. This module imports caller-supplied, vendor-provided records locally.
It cannot access accounts, read credentials, call the run.pay catalog, invoke
services, move money, create mandates, change custody, or attach settlement
checks. The existing package stays private and unpublished. No compatibility
with a deployed run.pay backend is claimed, and nothing imported here is
independently verified.

## Basis

Experimental compatibility work per
[rhein1/agoragentic-integrations#376](https://github.com/rhein1/agoragentic-integrations/issues/376).
The one built-in profile is `runpay.catalog.2026-09-09`, pinned to the
vendor-supplied fixtures exchanged in that thread on 2026-09-08/09.

The catalog endpoint
`GET https://runpay-backend-visibility-production.up.railway.app/api/services/catalog`
(query params `category`, `sort`, `limit` (max 200), `offset`, `max_price`,
`min_price`; pricing in USD decimal per call) is recorded as provenance only.
The importer and the tests **never fetch it**; there is no catalog polling
code path at all.

## Invariants

- **Attribution retained.** Every record carries `attribution: 'run.pay'` and
  `provenance: 'vendor_supplied_fixture'`. Imported records never become
  verified Agoragentic listings.
- **Exact-decimal prices.** `price_per_call` / `price_usd` must be JSON numbers;
  strings are rejected (`invalid_price`). The canonical form is the exact
  decimal string (`0.015`, never integer cents). The vendor confirmed
  `price_per_call` is unqualified `numeric` at the storage layer with no
  rounding or rejection rule.
- **Vendor-reported stats stay vendor-reported.** `trust_score`, `total_calls`,
  `avg_ms`, `error_rate` are imported under `vendor_reported` and are not
  verified and not a trust signal.
- **Intent, payment, and execution stay separate.** The declared intent link is
  opt-in, so records without `declared_intent` import with a
  `declared_intent_absent` warning. `payment_status` is provider-reported;
  execution evidence is absent (`execution_evidence_absent`). The three are
  never merged.
- **Redacted references are never settlement evidence.** A `transaction_id`
  containing `[redacted]` or an abbreviation imports with
  `settlement_ref_kind: 'redacted'` / `'abbreviated'` and
  `settlement_usable_as_evidence: false`. `assertRunpaySettlementEvidence`
  throws `invalid_settlement_evidence` for anything that is not a full
  `evm_tx_hash`.
- **Unknown fields are dropped before hashing.** Dropped field names are listed
  in `assessment.dropped_fields`; the source-core digest covers only immutable
  fields.
- **No independent checks.** Settlement, authority, commercial price, and
  outcome are always `not_checked`; overall evidence stays `unresolved` (or
  `contradicted` / `unsupported`).

## What stays unassessed

- The EIP-712 mandate / spending-authorization chain (owner mandate,
  authorization decision, execution, output linkage) — the issue thread asks
  how run.pay records link these; the adapter does not validate any of it.
- Live catalog shape, pagination, and the 204 undeclared services (only 2 of
  206 had declared schemas as of 2026-09-09).
- Invocation, payment rails, and settlement verification.

## Schema-declaration gaps

Per-service declaration status is pinned in the profile for the two fixture
services. Any other service id imports with `schema_declaration: {input:
'undeclared', output: 'undeclared'}` and a `schema_declaration_unknown`
warning. Consensus Aggregator's missing `schema_output` is preserved as a real
gap, not synthesized.

## Run locally

From `transaction-assurance/`:

```sh
npm run test:runpay
node bin/agora-assure.mjs runpay import \
  examples/runpay/2026-09-09/service-fixtures.json \
  --out /tmp/runpay-out --namespace sandbox:runpay-issue-376
```

Dependency installation is a separate development step; the importer itself has
no third-party runtime dependency and makes no network calls. The batch JSON
and its SHA-256 digest are written into `--out` with exclusive creation and
private file permissions. Existing files are never overwritten. Nothing is
saved unless the caller requests it.
