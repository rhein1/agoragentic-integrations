# Optional TOPLOC Evidence

Transaction Assurance can carry a scoped TOPLOC result reference as one untrusted piece of inference evidence.

```javascript
import {
  attachToplocEvidence,
  computeToplocAttestationHash,
  normalizeToplocEvidence,
  summarizeToplocEvidence,
  verifyToplocEvidence,
} from '@agoragentic/transaction-assurance/toploc-evidence';
```

## Scope

The adapter records the result declared by its caller for one model, configuration, proof, validator, and execution scope:

```text
scope = model_configuration_execution
```

It requires an exact TOPLOC scheme version, model reference, lowercase SHA-256 configuration hash, proof reference and hash, validator reference and version, status, validation timestamp for final statuses, and optional bounded evidence references. Each collection is capped at 100 attestations and rejects duplicate `attestation_id` values. Raw activations and raw proof payload fields are rejected; keep source material in an access-controlled evidence store.

## Verification Boundary

This adapter does not run TOPLOC, authenticate the validator, retrieve the referenced proof, compare source bytes, or scan caller strings for private data. Consequently every normalized v1 record is explicit about these states:

```text
trust.verification_status = not_verified
provenance.verification_status = not_verified
privacy.verification_status = not_verified
privacy.public_safe_status = not_verified
source_exactness.verification_status = not_verified
```

An `accept` status is the caller's declared validator result. It is not trusted proof. Summaries preserve the declared result but never report a trusted acceptance; absent a declared rejection, their actionable status remains `review`.

The adapter rejects caller-supplied authority, certification, trust, public-safety, and source-exactness fields. A future adapter may promote those states only after a real, separately reviewed scanner or verifier runs and supplies durable evidence.

## Reproducible Hashes

`attestation_hash` is SHA-256 over the canonical UTF-8 JSON of the complete attestation with only `attestation_hash` replaced by `null`. `computeToplocAttestationHash(attestation)` reproduces this value. The hash is assigned after every other attestation field is final.

`verifyToplocEvidence(attestation)` requires JSON-only values, checks the embedded hash, and then reconstructs the exact canonical v1 object. A matching self-hash detects mutation; it does not authenticate the caller, validator, source proof, or provenance.

`attachToplocEvidence(envelope, entries, { updatedAt })` first verifies the parent envelope hash, every existing schema-tagged TOPLOC entry, and any existing summary. It then attaches normalized evidence, clears `complete_chain_verified`, finalizes `updated_at`, and computes `evidence.envelope_hash` last with the parent package's `computeEnvelopeHash` recipe.

## Non-claims

A TOPLOC attestation does not by itself prove output correctness, task fulfillment, seller identity, payment settlement, delivery, full transaction reconciliation, certification, trust, or authority. The Transaction Assurance evaluator must still bind principal authority, seller and terms, payment, execution, delivery, outcome validation, and reconciliation.

This is a generic evidence adapter, not a partnership or validated package-compatibility claim. The package remains private and unpublished while external compatibility and release provenance are incomplete.
