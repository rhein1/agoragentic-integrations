# Optional TOPLOC evidence

Transaction Assurance may carry a reference to a scoped TOPLOC validation result as one piece of inference evidence.

```javascript
import {
  attachToplocEvidence,
  normalizeToplocEvidence,
  summarizeToplocEvidence,
} from '@agoragentic/transaction-assurance/toploc-evidence';
```

## Scope

The adapter records only a claim about the named validation result for the declared model/configuration execution scope:

```text
scope = model_configuration_execution
```

It requires:

- exact TOPLOC scheme version;
- model reference;
- configuration hash;
- proof reference and proof hash;
- validator reference and version;
- status and validation timestamp;
- optional bounded evidence references.

Raw activations and raw proof payloads are rejected. Keep them in an access-controlled evidence store.

## Non-claims

An accepted TOPLOC attestation does not by itself prove:

- output correctness;
- task fulfillment;
- seller identity;
- payment settlement;
- delivery;
- full transaction reconciliation;
- certification or trust endorsement.

Attaching the evidence clears `complete_chain_verified` and recomputes the envelope hash. The full Transaction Assurance evaluator must still bind principal authority, seller/terms, payment, execution, delivery, outcome validation, and reconciliation.

This is a generic evidence adapter, not a claim of partnership or validated package compatibility. An exact TOPLOC and validator version must be exercised before public compatibility language is used.
