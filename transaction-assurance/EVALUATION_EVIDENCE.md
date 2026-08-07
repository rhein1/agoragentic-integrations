# Transaction Assurance evaluator evidence

Transaction Assurance can attach scoped outcome-evaluation evidence without treating a score as proof that the entire commercial transaction is complete.

```javascript
import {
  attachEvaluationEvidence,
  normalizeEvaluationEvidence,
  summarizeEvaluationEvidence,
} from '@agoragentic/transaction-assurance/evaluation-evidence';
```

## Evidence shape

Each entry preserves:

- environment identifier, version, and optional hash;
- task identifier;
- harness identifier and version;
- exact evaluator identifiers, versions, types, results, and bounded scores;
- model reference for model judges;
- rubric hash and evidence references;
- trace and artifact hashes/references;
- redaction and source-exactness state.

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

## Attach to an envelope

```javascript
const updated = attachEvaluationEvidence(envelope, {
  environment_id: 'agoragentic-transaction-assurance-v1',
  environment_version: '0.1.0',
  environment_hash: 'sha256:...',
  task_id: 'payment-without-delivery',
  harness: { id: 'prime-agent', version: '...' },
  evaluators: [
    {
      id: 'delivery-contract-verifier',
      version: '1.0.0',
      type: 'deterministic',
      result: 'pass',
      score: 1
    }
  ],
  trace_hash: 'sha256:...',
  artifact_refs: ['receipt://...'],
  redaction_state: 'public_safe'
});
```

Attaching evaluator evidence recomputes the envelope hash and deliberately clears `complete_chain_verified`. The normal Transaction Assurance evaluation must still establish authority, terms, payment, execution, delivery, finality, and reconciliation.

## Truth boundary

```text
payment settled
≠ task succeeded

task returned output
≠ output passed evaluation

scoped evaluation passed
≠ complete transaction verified

receipt produced
≠ certification or trust endorsement
```

Original traces are not embedded. The record states whether normalization was believed lossless, but retains hashes and references rather than raw prompts, unrestricted tool output, credentials, wallet-private material, or private owner data.
