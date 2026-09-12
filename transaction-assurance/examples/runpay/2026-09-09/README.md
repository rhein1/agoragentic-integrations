# run.pay offline evidence fixtures

Read [the importer contract](../../../docs/runpay-offline-importer.md) before
using these fixtures. They are vendor-supplied offline test data from
[rhein1/agoragentic-integrations#376](https://github.com/rhein1/agoragentic-integrations/issues/376),
not production records or proof of payment.

- `service-fixtures.json`: two service records verbatim as supplied by PalabreX
  (Consensus Aggregator, Phone Validator), including declared input/output
  schemas. Consensus Aggregator has **no** declared `schema_output`; that gap is
  real and is preserved, not filled in.
- `observability-record.json`: redacted observability record for a real
  completed call, verbatim. Its `transaction_id` is vendor-redacted and is
  never usable as settlement evidence.
- `provenance.json`: source identity, fixture-byte digests, claim boundary, and
  the no-fetch attestation for the catalog endpoint.
- `synthetic-expected.json`: golden batch import of `service-fixtures.json`
  under namespace `sandbox:runpay-issue-376`; every independent check remains
  `not_checked` and the overall evidence stays `unresolved`.

The catalog endpoint
`GET https://runpay-backend-visibility-production.up.railway.app/api/services/catalog`
is recorded as provenance only and is **never fetched** by the importer or the
tests. From the package root, run `npm run test:runpay`, or:

```sh
node bin/agora-assure.mjs runpay import \
  examples/runpay/2026-09-09/service-fixtures.json \
  --out /tmp/runpay-out --namespace sandbox:runpay-issue-376
```

Never submit these fixtures, or the golden output, as evidence of actual
settlement or production compatibility.
