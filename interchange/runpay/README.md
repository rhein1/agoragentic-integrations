# run.pay Interchange offline adapter

This private, source-only package normalizes a pinned run.pay compatibility fixture into reviewable Agoragentic Interchange records. It is an offline proof for [issue #376](https://github.com/rhein1/agoragentic-integrations/issues/376), not a live connector.

The fixture set contains two of the 206 services reported in the issue evidence:

| Service | Price | Input schema | Output schema |
| --- | ---: | --- | --- |
| Phone Validator | `0.015` USD/call | `declared` | `reconstructed` from a successful response and later catalog-returned |
| Consensus Aggregator | `0.02` USD/call | `declared` | `missing` |

Every money value crosses the adapter boundary as an exact decimal string. JavaScript numbers, exponent notation, signs, whitespace, and malformed leading zeros are rejected. The adapter preserves the source string and never rounds or converts it through binary floating point. This follows the issue evidence that run.pay stores `price_per_call` as arbitrary-precision PostgreSQL `numeric` without a fixed scale.

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
