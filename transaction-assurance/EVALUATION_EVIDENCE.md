# Transaction Assurance evaluator evidence

Transaction Assurance can attach scoped outcome-evaluation evidence without treating a score as proof that the entire commercial transaction is complete.

```javascript
import { sha256Ref } from '@agoragentic/transaction-assurance';
import {
  attachEvaluationEvidence,
  computeEvaluationEvidenceHash,
  normalizeEvaluationEvidence,
  summarizeEvaluationEvidence,
  verifyEvaluationEvidence,
} from '@agoragentic/transaction-assurance/evaluation-evidence';
```

## Evidence shape

Each entry requires:

- environment identifier, version, and SHA-256 hash;
- task identifier;
- harness identifier and version;
- exact evaluator identifiers, versions, types, results, and bounded scores;
- a model reference for every model judge;
- a rubric hash and at least one evidence reference for every evaluator;
- a trace hash, artifact references, and observation timestamp;
- a detached hash over the complete canonical evidence record.

Evaluator types are explicit:

```text
deterministic
model_judge
human_review
external_attestation
```

Model-judge-only evidence remains `review` even when its scoped result is `pass`. A deterministic failure produces a failed scoped summary. A passing scoped summary still keeps:

```text
complete_transaction_verified = false
certification = false
authority_granted = false
```

## Normalize and verify

```javascript
const evidence = normalizeEvaluationEvidence({
  environment_id: 'agoragentic-transaction-assurance-v1',
  environment_version: '0.1.0',
  environment_hash: sha256Ref({ environment: 'pinned-definition' }),
  task_id: 'payment-without-delivery',
  harness: { id: 'prime-agent', version: '0.1.0' },
  evaluators: [
    {
      id: 'delivery-contract-verifier',
      version: '1.0.0',
      type: 'deterministic',
      result: 'pass',
      score: 1,
      rubric_hash: sha256Ref({ rubric: 'delivery-contract-v1' }),
      evidence_refs: ['receipt://example']
    }
  ],
  trace_hash: sha256Ref({ trace: 'access-controlled-trace' }),
  artifact_refs: ['receipt://example'],
  observed_at: new Date().toISOString()
});

verifyEvaluationEvidence(evidence);
```

`computeEvaluationEvidenceHash()` hashes the canonical record with only `evidence_hash` replaced by `null`. `verifyEvaluationEvidence()` checks that detached hash and then requires the complete canonical shape. A matching `schema` string never bypasses field, provenance, privacy-state, or hash checks.

The required hashes establish integrity for the declared record and its referenced lineage. This package does not dereference artifacts, verify an external evaluator's identity, or prove that a referenced trace or rubric is trustworthy.

## Attach to an envelope

```javascript
const updated = attachEvaluationEvidence(envelope, evidence);
```

Attachment verifies the source envelope hash, verifies every previously attached schema-tagged entry, normalizes or verifies each new entry, updates the envelope, clears `complete_chain_verified`, and computes the parent envelope hash last. The normal Transaction Assurance evaluation must still establish authority, terms, payment, execution, delivery, finality, and reconciliation.

## Privacy boundary

The module does not contain a content scanner. It therefore emits:

```text
redaction_state = not_verified
source_exactness.normalization_lossless = false
source_exactness.verification_status = not_verified
```

Caller assertions such as `public_safe` are not propagated. Free-text notes and references are preserved, so callers must still scrub or access-control them before publication. Original trace bodies have no dedicated field and are not embedded by the normalizer, but a reference, note, or identifier can still contain sensitive text if a caller supplies it.

## Truth boundary

```text
payment settled
!= task succeeded

task returned output
!= output passed evaluation

scoped evaluation passed
!= complete transaction verified

self-hash verified
!= external provenance verified

receipt produced
!= certification or trust endorsement
```
