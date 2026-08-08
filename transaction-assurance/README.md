# Agoragentic Transaction Assurance

> **Payment rails prove money moved. This package helps prove the authorized job ran, the promised outcome was delivered, and the transaction was reconciled when it did not.**

`@agoragentic/transaction-assurance` is an experimental, local, deterministic, no-network library for autonomous agent transactions.

It normalizes authority and payment evidence from multiple protocol families into a conservative record that binds:

```text
principal
→ delegated authority
→ agent
→ seller and terms
→ payment
→ execution
→ delivered outcome
→ verification
→ reconciliation
```

The package does **not** move money, create or fund wallets, sign payments, execute a seller, deploy an agent, publish a listing, mutate trust, or grant authority.

## Why this exists

A payment can be valid and final while the commercial outcome is still wrong:

- the agent was not authorized for that merchant, category, action, rail, or amount;
- seller terms changed after selection;
- a retry duplicated payment or work;
- money settled but execution failed or timed out;
- output was returned but did not satisfy the task contract;
- delivery cannot be verified;
- refund, dispute, or partial failure remains unresolved.

Wallets, payment protocols, card networks, identity systems, and marketplaces each prove important parts of the event. Transaction Assurance creates one bounded place to evaluate whether the parts belong to the same authorized outcome.

## Status

This is an unpublished alpha implementation on a review branch.

- package: `@agoragentic/transaction-assurance`
- version: `0.1.0-alpha.0`
- network calls: none
- spend authority: none
- protocol recognition: implemented
- external cryptographic verifiers: not yet implemented
- hosted Agoragentic execution changes: none
- marketplace catalog entry: intentionally deferred

`package.json` remains `private: true` until review, conformance fixtures, provenance, and release ownership are complete.

## Five-minute local proof

From this repository checkout:

```bash
cd transaction-assurance
npm test
npm run self-test
```

Expected self-test result:

```json
{
  "ok": true,
  "protocol": "agoragentic_mandate",
  "state": "authority_ready",
  "decision": "allow",
  "no_network": true,
  "no_spend": true,
  "authority_granted_by_cli": false
}
```

## Public API

```javascript
import {
  detectAuthorityProtocol,
  normalizeAuthorityArtifact,
  buildAuthorityRequest,
  buildTransactionAssuranceEnvelope,
  evaluateTransactionAssuranceEnvelope,
  canonicalize,
  computeEnvelopeHash,
  sha256Ref,
} from '@agoragentic/transaction-assurance';
```

### Detect a protocol family

```javascript
const detection = detectAuthorityProtocol(externalArtifact);
```

Detection recognizes structural markers for:

- native Agoragentic mandates;
- Google AP2;
- Visa Trusted Agent Protocol;
- OpenAI/Stripe Agentic Commerce Protocol;
- x402 Payment Identifier, payment, offer, and receipt artifacts;
- Circle Agent Wallet policy evidence;
- Skyfire KYA/KYAPay;
- Mastercard Verifiable Intent where public artifacts permit;
- unknown/other artifacts.

**Detection is not verification.** A recognized object remains unverified until a version-specific verifier supplies evidence.

### Normalize authority without weakening it

```javascript
const normalized = normalizeAuthorityArtifact(externalArtifact, {
  artifactRef: 'vault://authority/123',
  verification: {
    status: 'verified',
    verifierRef: 'verifier://ap2/v1',
    evidenceRef: 'receipt://signature-check/456',
    checkedAt: new Date().toISOString(),
  },
  revocation: {
    status: 'active',
    evidenceRef: 'receipt://revocation-check/789',
    checkedAt: new Date().toISOString(),
  },
});
```

The normalized record stores the source reference and a deterministic hash. It does not embed the source artifact, credentials, private keys, or raw payment data.

When no verifier evidence is supplied, status defaults to `unverified` and pre-execution evaluation fails closed. A `verified` status requires a verifier reference, evidence reference, and check timestamp. An `active` or `revoked` revocation result likewise requires its own evidence reference and check timestamp; bare caller assertions are rejected.

### Let an agent prepare—not approve—an authority request

```javascript
const request = buildAuthorityRequest({
  principalRef: 'owner:acme',
  agentId: 'agent:research-buyer',
  purpose: 'Purchase bounded research calls',
  allowedActions: ['execute:research'],
  allowedCategories: ['research'],
  allowedPaymentRails: ['x402'],
  currency: 'USDC',
  maxPerAction: '0.10',
  maxDaily: '1.00',
  maxTotal: '5.00',
});
```

Every generated request has:

```text
status = pending_principal_approval
approval = null
request_grants_authority = false
all authority flags = false
```

An agent can prepare the request and hand it to an owner-control channel. It cannot approve itself or expand its own scope.

### Build a pre-execution assurance envelope

```javascript
const envelope = buildTransactionAssuranceEnvelope({
  principalRef: 'owner:acme',
  principalType: 'organization',
  principalIdentityVerification: 'verified',
  principalIdentityEvidenceRef: 'identity-proof://principal/123',
  agentRef: 'agent:research-buyer',
  agentIdentityVerification: 'verified',
  agentIdentityEvidenceRef: 'identity-proof://agent/456',
  normalizedAuthority: normalized,
  commercialIntent: {
    action: 'execute:research',
    taskRef: 'task:brief-123',
    sellerRef: 'seller:provider-7',
    capabilityRef: 'capability:deep-research',
    category: 'research',
    quotedAmount: '0.05',
    currency: 'USDC',
    termsMatchStatus: 'match',
  },
  payment: {
    paymentIdentifier: 'payment:unique-123',
    rail: 'x402',
    amount: '0.05',
    currency: 'USDC',
    dailySpendBefore: '0.20',
    totalSpendBefore: '1.20',
    budgetUsageRef: 'ledger-proof://budget/789',
  },
  execution: {
    idempotencyKeyHash: sha256Ref('private-idempotency-value'),
    inputHash: sha256Ref({ query: 'bounded input' }),
  },
});
```

The envelope itself grants no authority. It carries evidence and decision context only.

The principal and agent references are bound to the verified normalized authority artifact. Callers cannot substitute different identities after verification. Authority scope lists must be non-empty; an omitted list is not interpreted as unrestricted authority. Daily and total budget limits require a referenced usage snapshot so the evaluator can check the prospective spend exactly with decimal-string arithmetic.

`evidence.envelope_hash` is reproducible with `computeEnvelopeHash(envelope)`. The recipe canonicalizes the full envelope with only `evidence.envelope_hash` replaced by `null`, then hashes those UTF-8 bytes with SHA-256. Evaluation rejects an envelope whose embedded hash no longer matches that recipe.

### Evaluate before execution

```javascript
const evaluation = evaluateTransactionAssuranceEnvelope(envelope, {
  phase: 'pre_execution',
});
```

Possible decisions:

- `allow` — required pre-execution authority and commercial checks passed;
- `review` — evidence is missing or ambiguous;
- `deny` — authority, scope, terms, amount, merchant, rail, replay, or expiry failed.

`allow` means the envelope passed this deterministic check. It is not a payment, execution, owner approval, or guarantee that a live rail remains available.

### Evaluate after execution

```javascript
const evaluation = evaluateTransactionAssuranceEnvelope(completedEnvelope, {
  phase: 'post_execution',
});
```

`complete_chain_verified` is true only when required checks establish:

- verified active authority;
- authority-bound and independently evidenced principal and agent identities;
- matching action, seller, category, rail, currency, quote, and terms;
- referenced daily and total budget usage within the approved limits;
- idempotent execution without duplicate detection;
- observed, verified, final settlement with payment, receipt, and settlement references;
- successful execution with an invocation reference and output hash;
- delivered and verified outcome with artifact, seller-attestation, and validation references;
- complete or refunded reconciliation.

## CLI

```bash
node bin/agora-assure.mjs detect examples/native-mandate.json
node bin/agora-assure.mjs normalize examples/native-mandate.json
node bin/agora-assure.mjs authority-request examples/authority-request-input.json
node bin/agora-assure.mjs self-test
```

The CLI reads and writes local JSON only. It never makes a network call.

## State model

```text
incomplete
→ authority_ready
→ payment_pending
→ payment_observed
→ execution_observed
→ outcome_verified
→ reconciled
```

Alternative states:

```text
failed
refunded
disputed
```

State names are summaries. Structured evidence and evaluation blockers remain authoritative.

## Safety and privacy contract

The library is designed to carry references, hashes, statuses, and bounded summaries. Do not pass raw secrets into public records.

Generated envelopes assert exclusion of:

- raw prompts;
- raw tool output;
- payment credentials;
- wallet private data;
- private owner data;
- secrets.

A hash can still reveal equality and may be sensitive when computed over a small guessable input. Store public hashes only when that disclosure is acceptable. Keep raw source artifacts in an access-controlled system.

## Protocol adapters

The initial implementation performs conservative structural recognition and generic field normalization. It does not yet implement cryptographic verification for AP2, TAP, official ACP, x402 signed artifacts, Circle, Skyfire, or Verifiable Intent.

A production adapter must:

1. pin the exact protocol and schema version;
2. preserve a source reference and stable artifact hash;
3. verify issuer, signature/token, audience, merchant binding, expiry, and revocation where supported;
4. expose unsupported checks as `unverified`, `not_checked`, or `unknown`;
5. include deterministic positive and negative conformance vectors;
6. avoid partnership or endorsement claims without evidence.

## Relation to Agoragentic Interchange

This package is an OSS preparation and conformance layer. Hosted Agent Commerce Interchange already has native mandates, quotes, execution references, settlement evidence, signed receipts, disputes, refunds, and reconciliation.

A future versioned integration can feed normalized external evidence into those existing contracts. This alpha does not change hosted execution, payment, custody, or marketplace behavior.

## Product direction

- [Program issue](https://github.com/rhein1/agent-marketplace/issues/1254)
- [OSS implementation issue](https://github.com/rhein1/agoragentic-integrations/issues/239)
- [Agent setup contract](https://agoragentic.com/agent-setup.md) — available after the corresponding website PR is merged and deployed

## License

Apache-2.0. See [LICENSE](LICENSE).
