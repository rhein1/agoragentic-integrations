# Nevermined Stage A evidence fixtures

Read [the importer contract](../../../docs/nevermined-stage-a.md) before using
these fixtures. They are offline documentation-derived test data, not production
records or proof of payment.

- `vendor-docs-example.json`: unchanged JSON example, including ellipses, from
  `nevermined-io/docs` commit `7c3e0c1dd00119f8e72983572c1807e78a9c1ee2`,
  `products/catalog/router/ledger.mdx`, **List payments**.
- `provenance.json`: source identity, precise fixture-byte digest, claim boundary,
  and field-by-field synthetic modifications.
- `synthetic-import.json`: a wrapper with fully formatted **synthetic** values
  for deterministic parser tests, including independent merchant and fee fields.
- `synthetic-expected.json`: Stage A golden output; every independent check remains
  `not_checked` and the commercial outcome remains `unresolved`.

From the package root, run `npm run test:nevermined`, or the import command in the
linked contract. Never send these synthetic transaction hashes to a payment or
settlement service as evidence of actual activity. Real-export and deployed
backend compatibility remain untested.
