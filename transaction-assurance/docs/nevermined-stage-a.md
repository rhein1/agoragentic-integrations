# Nevermined evidence importer: Stage A

Source-only extension of `@agoragentic/transaction-assurance`, not another product.
This module imports caller-supplied records locally. It cannot access accounts,
read credentials, call a merchant, invoke RPC, move money, create delegations,
change custody, or attach settlement checks. The existing package stays private
and unpublished. No compatibility with a deployed Nevermined backend is claimed.

## Supported evidence and fixture amendment

The one built-in profile is `nevermined.merchant-payment.7c3e0c1dd00119f8e72983572c1807e78a9c1ee2`.
It pins the **documentation**, not an API-version guarantee:

- Repository: `nevermined-io/docs`
- Commit: `7c3e0c1dd00119f8e72983572c1807e78a9c1ee2`
- File: `products/catalog/router/ledger.mdx`, section **List payments**
- Git blob: `40c5314dba599315497bf6a3d240f5ea8598b433`
- Documented endpoint: `GET /api/v1/router/payments`
- Source: <https://github.com/nevermined-io/docs/blob/7c3e0c1dd00119f8e72983572c1807e78a9c1ee2/products/catalog/router/ledger.mdx>

This is the merchant-payment ledger, **not** the delegation charge ledger.
Merchant `amount` is an atomic string with explicit `assetDecimals`; fee atomic
amount and budget cents are different evidence fields. No cent conversion or
netting is performed. A supplied `Settled` status remains a caller-supplied
provider assertion, not an independently confirmed transfer.

The September 9 implementation decision permits a vendor documentation example
and separately labeled synthetic fixtures for Stage A development. This narrowly
amends the v0.2 PDF's stronger real-export fixture gate; **that original gate has
not passed**. Real-export validation, API-version-header guarantees, production
interoperability, and external adoption remain unproven.

`examples/nevermined/7c3e0c1/vendor-docs-example.json` preserves the published JSON
block and its abbreviations. `provenance.json` identifies the source and exact
fixture-byte digest. `synthetic-import.json` changes identifiers, wallets, amounts,
and fee data as individually recorded in that sidecar. Synthetic values are not
observed payments and must never be submitted as evidence of actual settlement.
The abbreviated vendor example imports as incomplete and has no stable payment
identity or valid transaction-hash interpretation.

## Run locally

From `transaction-assurance/`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test:nevermined
node bin/agora-assure.mjs nevermined import \
  --input examples/nevermined/7c3e0c1/synthetic-import.json \
  --profile nevermined.merchant-payment.7c3e0c1dd00119f8e72983572c1807e78a9c1ee2
```

Dependency installation is a separate development step; the importer itself has
no third-party runtime dependency and makes no network calls. JSON is written to
stdout and a bounded human diagnosis to stderr. Use `--output <new-file>` to write
JSON with exclusive creation and private file permissions. Existing files and
symlinks are not overwritten. Nothing is saved unless the caller requests it.

A raw vendor-shaped object or array is also accepted by the CLI with an explicit
`--namespace sandbox:my-evidence-source`. Choose a stable non-secret namespace
that separates environments and unrelated source datasets. The wrapper form
shown in the fixture declares its namespace, profile and revision explicitly.
The CLI does not consult a saved account, environment variable, or network to
infer any of these values. Arbitrary mappings are not supported.

```js
import {
  normalizeNeverminedLedger,
  normalizeNeverminedExport,
  NEVERMINED_PROFILE_ID,
} from '@agoragentic/transaction-assurance/nevermined';

const record = normalizeNeverminedLedger(suppliedEnvelope, {
  profileId: NEVERMINED_PROFILE_ID,
  history: suppliedPreviousEnvelopes,
});
const batch = normalizeNeverminedExport(suppliedBatchEnvelope);
```

`history` contains **raw single-record import envelopes**, not previously asserted
assessment results. Supply it in either the envelope or the library option, never
both. The CLI's `--history` reads such a JSON array. History is re-normalized and
has no ability to add a trusted check. No hidden storage is used.

## Three clarified contracts

### Complete output and units

The closed output schema includes identifiers, delegation references, source
revision/profile provenance, original allowlisted scalars, merchant and buyer
wallets, provider-created time, settlement reference classification, and a
separate Router fee record. The fee record preserves atomic amount, scale,
network/asset, rate basis points, budget cents, status, transaction reference,
and authorization nonce. `feeCents: "0"` does not erase a nonzero atomic fee.
The pinned vendor shape has at most one flattened Router-fee leg; it does not
invent an array of additional fees or accept arbitrary vendor mappings.

Atomic money is accepted only as an integer **string**, capped at 78 digits.
Decimals must be explicit integers from 0 to 30. Invalid or unknown monetary
values remain visible in `core.original` but have no normalized amount/display.
Unknown networks, assets, protocols and opaque references are preserved, never
coerced into Base USDC. A Base-USDC candidate is eligibility metadata only; it
is not a chain observation, a balance check, or a payment approval.

### Immutable core versus assessment

`core` contains only stable source facts under the pinned interpretation and
redaction profile. Its byte-equivalence is defined by canonical serialization,
not JavaScript object prototypes or JSON indentation. `observation_context`
contains caller capture time and a non-secret record-reference digest; it is not
part of core identity. Processing timestamps are deliberately not generated.

The payment identity key uses provider + namespace + full stable payment ID.
The observation key additionally binds the redacted-source and profile digests.
Missing or abbreviated payment IDs yield null keys, never synthesized ones.
History changes `assessment.import_disposition` but cannot change the source core.
An added check, when Stage B is separately implemented, must change assessment
rather than invent a new provider snapshot.

A compatible different observation is labeled `update`; it does not assert that
it is newer by wall-clock time, select a latest winner, or discard earlier facts.
Missing facts are not incompatible facts. Conflicting non-null immutable fields,
merchant `Settled` versus `Failed`, or fee `Settled` versus `Released` are explicit
conflicts between **supplied assertions**. Fee budget-cents changes are preserved,
not used as a reason to fabricate settled or released money.

### Contradiction precedence

For one payment identity, contradictory supplied facts produce `conflict` and
`contradicted`, even if an exact duplicate also exists or delivery evidence is
missing. All chain, matching, amount-comparison, authority and outcome fields
still remain `not_checked`: the conflict is not a trusted chain finding. Full
batch comparison exposes conflicts on both affected observations; nothing is
automatically overwritten or retried. Known but unsupported checks are preserved
independently, and missing delivery cannot clear a contradiction.

## Privacy and digest scope

`core.original` is the **allowlisted, redacted projection**, not the original file.
Unknown properties and `feeFailureReason` are dropped before hashing and output.
HTTP(S) resource URLs lose userinfo, query and fragment; other URL schemes are
omitted. Recognized credential patterns in retained evidence fields cause a
value-free error. Never put secrets in source namespace/reference fields.
Pattern detection is not a universal secret detector: callers must not supply
credentials disguised as ordinary identifiers or paths.

`redacted_source_hash` hashes exactly that bounded projection using adapter-local
RFC 8785 serialization. It is not a byte hash of the export and deliberately
ignores removed fields. The extraction profile, redaction rules, digest scope
and canonicalization identifier accompany the digest. A hash is not an
attestation; every imported record stays `caller_supplied`. The shared legacy
canonicalizer is unchanged.

Strict parsing rejects duplicate decoded keys, unsafe prototype names, malformed
UTF-8, BOM, lone surrogates, non-finite/unsafe numeric literals, and executable
object values. Fixed limits are 1 MiB input, 32 nesting levels, 1,000 bounded
records/history entries and 64 KiB strings. The in-process API snapshots inert
JSON values and rejects proxies, accessors, cycles and custom prototypes.

## Process exits and stages

Default exit `0` means a report was emitted, not that a commercial event completed.
Invalid input/arguments return `64` with a stable error code and no report core;
unexpected internal failures return `70`. Repeated `--fail-on` flags opt into
`contradicted` (3), `unsupported` (4), then `unresolved` (2) precedence across the
batch. Empty exports remain explicit empty batches, not successful transactions.

Stage A never emits `evidence_complete`, validates authority, or promotes provider
status to settlement. `nevermined attach-settlement` explicitly returns
`stage_b_gated`. No Stage B API is exported. The stronger golden test involving
trusted chain checks/exact settlement is deferred; the Stage A golden snapshot
shows only a supplied assertion plus unassessed dimensions.

Before Stage B, pin a checker-artifact contract with complete binding and adequate
transfer evidence, implement an actual caller-configured trust path, and test
untrusted artifacts, incorrect binding, missing/pending/reverted transactions and
incomplete transfers. No fixture in this PR satisfies those gates.

## Validation

`test/nevermined-ledger.test.mjs` exercises parser, redaction, exact amounts,
provenance, snapshots/history, report generation, CLI exits and exclusive output.
The actual CLI is spawned with HTTP, fetch, sockets and DNS blocked before module
imports by `test/fixtures/nevermined-no-network-preload.mjs`.
`test/nevermined-schema.test.mjs` validates input/output/batch schemas and rejects
invented verification, identities and invalid output states with locked Ajv.
Existing package CI runs both files and the legacy regressions on Node 20/22/24.
Do not describe a test run on one runtime as that entire matrix passing.
