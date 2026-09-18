# run.pay Interchange offline adapter

This private, source-only package normalizes a pinned run.pay compatibility fixture into reviewable Agoragentic Interchange records. It is an offline proof for [issue #376](https://github.com/rhein1/agoragentic-integrations/issues/376), not a live connector.

It also contains an offline processor for the bounded public-catalog trial authorized in [issue #395](https://github.com/rhein1/agoragentic-integrations/issues/395). The processor accepts operator-captured response bytes and a capture manifest; it has no HTTP client and cannot repeat the trial.

The fixture set contains two of the 206 services reported in the issue evidence:

| Service | Price | Input schema | Output schema |
| --- | ---: | --- | --- |
| Phone Validator | `0.015` USD/call | `declared` | `reconstructed` from a successful response and later catalog-returned |
| Consensus Aggregator | `0.02` USD/call | `declared` | `missing` |

Every money value crosses the adapter boundary as an exact decimal string. JavaScript numbers, exponent notation, signs, whitespace, and malformed leading zeros are rejected. The adapter preserves the source string and never rounds or converts it through binary floating point. This follows the issue evidence that run.pay stores `price_per_call` as arbitrary-precision PostgreSQL `numeric` without a fixed scale.

The canonical vendor-supplied source bytes live under
`transaction-assurance/examples/runpay/2026-09-09/`. This package is their
Interchange projection: it converts the three money tokens to exact decimal
strings, represents an absent output schema explicitly as `null`, and adds
fixture provenance. `provenance.json` pins both source files by SHA-256, and
`canonical-fixtures.test.mjs` rejects byte drift or any other service/receipt
content change.

Schema provenance is explicit. `declared` means the service supplied the schema, `reconstructed` means it was inferred from the documented successful response and later stored by run.pay, and `missing` means the fixture has no schema. A missing schema stays `null`; the adapter does not invent one.

The redacted receipt fixture is normalized as an observation only. Its source-reported `payment_status: completed` remains source-reported. It does not prove that the provider ran, an outcome exists, the named vendor controls an account, a chain receipt was observed, or settlement was confirmed. The optional declared intent is linked by a hash and checked against category and exact maximum price, but it remains unverified authorization.

All outputs fail closed:

- no live catalog request or background polling
- no provider credentials, account binding, invocation, wallet, payment, or spend
- no trust mutation, verified status, listing publication, or public execution eligibility
- no settlement or outcome verification
- no deployment or production activation

## Run the offline proof

Requires Node.js 20 or newer.

```bash
cd interchange/runpay
npm ci --ignore-scripts
npm run check
npm test
npm run replay
```

Normalize one pinned service fixture:

```bash
node normalize.mjs --service fixtures/phone-validator.json
```

Normalize the redacted receipt against its service fixture:

```bash
node normalize.mjs \
  --service fixtures/phone-validator.json \
  --receipt fixtures/phone-validator-receipt.json
```

The output contracts are [`runpay-service-import.schema.json`](./runpay-service-import.schema.json) and [`runpay-receipt-observation.schema.json`](./runpay-receipt-observation.schema.json). [`provenance.json`](./provenance.json) records the reviewed source references and evidence limits.

## Promotion requirements

A future live adapter needs a separately reviewed catalog transport, authenticated provider and account binding, current reachability evidence, commercial terms, execution authorization, outcome validation, payment authorization, and independent settlement verification. Those capabilities are outside this reference and require separate authorization and review.

## Bounded read-only catalog evidence

The authorized trial ran on 2026-09-14 with three unauthenticated `GET`
requests: the first ten records twice, followed by records 11–20. The first
page was byte-identical across both captures, the two distinct pages had no
service overlap, and the catalog reported 210 services. No credential,
provider invocation, payment, wallet action, redirect, listing publication,
trust mutation, deployment, or activation was used.
The processor enforces that exact request plan and rejects duplicate or extra
query parameters.

The capture also found contract drift that blocks automatic fixture/profile or
listing updates:

- the reported total changed from 206 to 210;
- the top-level response includes `has_more`;
- `categories` differed between pages and cannot be treated as a catalog-wide
  list from this evidence;
- `schema_input` and `schema_output` were absent for both fixture service IDs,
  despite the earlier issue statement that they were returned by the catalog;
- seven observed service fields sit outside the pinned offline allowlist and
  remain omitted from normalized output.

The checked-in [redacted evidence packet](./evidence/readonly-catalog-2026-09-14.json)
contains raw-response byte counts and SHA-256 digests, exact decimal price
tokens, pseudonymous hashed service/vendor linkage references, hash-bound request
timestamps and canonical URLs, pagination observations, and all-false
authority flags. Raw responses remain operator-local and are not committed.
The stable service/vendor hashes allow correlation and may be dictionary
matched against the public catalog; they are pseudonymous references, not a
secrecy guarantee.
The three-request authorization is exhausted; another network request needs a
new explicit authorization.

Replay the processor against operator-held captures without network access:

```bash
node readonly-catalog-evidence.mjs \
  --manifest capture-manifest.json \
  --capture response-1.json \
  --capture response-2.json \
  --capture response-3.json
```

[`readonly-catalog-evidence.schema.json`](./readonly-catalog-evidence.schema.json)
defines the strict packet contract. Tests exercise deterministic replay,
exact-decimal retention, digest tampering, request and endpoint bounds,
redaction, contract drift, schema validation, and authority escalation denial.
