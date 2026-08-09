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
- version: `0.2.0-alpha.0`
- network calls: none
- spend authority: none
- protocol recognition: implemented
- external cryptographic verifiers: trusted in-process callback interface implemented; verifier implementations remain external
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

The CLI reads and writes local JSON only. It never makes a network call. Its `normalize` command always produces `unverified` / `not_checked` evidence; command-line flags cannot promote an artifact to verified or active. Verification evidence must come from a separately reviewed adapter or institutional verifier using the library API.

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

Generated envelopes expose a conservative `redaction.verification_status = not_verified` record. The exclusion booleans default to `false`; the builder does not claim that arbitrary caller-supplied references or summaries are public-safe merely because raw payload fields are absent. Integrators must validate or scrub their supplied strings before publication.

The envelope schema does not include dedicated fields for:

- raw prompts;
- raw tool output;
- payment credentials;
- wallet private data;
- private owner data;
- secrets.

A hash can still reveal equality and may be sensitive when computed over a small guessable input. Store public hashes only when that disclosure is acceptable. Keep raw source artifacts in an access-controlled system. Do not promote the redaction status without a separately reviewed content scanner or provenance-aware producer.

## Protocol adapters

Version-specific, no-network adapters are available from the package root or the `./protocol-adapters` export:

```javascript
import {
  normalizeAp2Authority,
  normalizeVisaTapEvidence,
  normalizeOfficialAcpEvidence,
  normalizeX402Evidence,
  bindX402OutcomeEvidence,
  normalizeCircleWalletPolicyEvidence,
  normalizeSkyfireKyaPayEvidence,
  normalizeMastercardVerifiableIntentEvidence,
} from '@agoragentic/transaction-assurance/protocol-adapters';
```

Supported source pins are exported as `PROTOCOL_ADAPTER_PINS`:

| Adapter | Supported public source |
| --- | --- |
| Google AP2 | `v0.2.0` / `b4587ac1...` |
| Visa Trusted Agent Protocol | commit `16d59bdf...` |
| official OpenAI/Stripe ACP | released schema `2026-04-17` at `7fdd78df...` |
| x402 offer/receipt + Payment Identifier | `@x402/core` `2.21.0` at `34cb6bd0...` |
| Circle Agent Stack policy evidence | `circlefin/skills` commit `c7d269a2...` |
| Skyfire KYA/KYAPay evidence | `skyfire-xyz/kyapay` commit `869a71ae...` |
| Mastercard Verifiable Intent | public-materials snapshot `2026-08-08`; no immutable public schema, so verifier promotion is rejected and private-network compatibility is unknown |

The adapters do not verify signatures themselves. A separately controlled verifier must be supplied as a trusted in-process callback. The callback returns a strict `agoragentic.protocol-verifier-evidence.v1` record that binds the exact protocol version, source artifact hash, normalized binding hash, durable evidence references, timestamp, revocation result, and every protocol-specific check. The library also binds the verified result to that callback through a non-serializable process-local trust boundary. A caller cannot turn parsing into `verified` by supplying JSON or setting a status string, and a serialize/deserialize round trip deliberately loses verified authority. Mismatched hashes, missing checks, false checks under a `verified` claim, unknown versions, inactive revocation, and missing callback provenance all fail closed.

x402 signed-offer, signed-receipt, and settlement callbacks return the narrower `agoragentic.signed-artifact-verifier-evidence.v1` record. Each result binds the exact artifact hash and a purpose-specific binding hash. Challenge observation, payment submission, payment observation, verified settlement, final settlement, receipt verification, external verification, and delivered outcome remain separate states. `bindX402OutcomeEvidence()` reports external verification as `not_checked` unless a future separately reviewed adapter establishes it; settlement or receipt evidence never implies delivery. The included `examples/x402-generic-middleware.mjs` demonstrates a no-network middleware assessment that never sends or retries payment and never marks delivery verified.

Adapter outputs retain only bounded public references, hashes, statuses, and binding metadata. Raw signatures, delegated-payment payloads, wallet credentials, KYA tokens, payment containers, private keys, and checkout bodies are never copied into the normalized result.

These adapters do **not** claim Google, Visa, OpenAI, Stripe, x402 Foundation, Circle, Skyfire, or Mastercard endorsement or universal production compatibility. Merchant-declared ACP fulfillment remains distinct from independently verified delivery, and an x402 signed receipt or final settlement remains distinct from delivered outcome evidence. The Mastercard export is deliberately reference-only until an immutable public Verifiable Intent schema exists.

A production verifier must:

1. pin the exact protocol and schema version;
2. preserve a source reference and stable artifact hash;
3. verify issuer, signature/token, audience, merchant binding, expiry, and revocation where supported;
4. expose unsupported checks as `unverified`, `not_checked`, or `unknown`;
5. include deterministic positive and negative conformance vectors;
6. avoid partnership or endorsement claims without evidence.

Deterministic, license-attributed adapter vectors live in `test/fixtures/protocol-adapter-vectors.v1.json` and run on Node 20, 22, and 24. They cover unsupported versions, wrong audience/merchant/purpose, expiry, replay, changed cart/terms, payment-identifier mismatch, payment without delivery, wallet-policy scope failures, and privacy exclusions.

### AP2 field map

| AP2 evidence | Normalized field |
| --- | --- |
| artifact reference and canonical content | `source_artifact_ref`, `source_artifact_hash` |
| mandate family (`vct`) | `protocol_binding.artifact_kind` |
| mandate issuer and principal | `issuer_ref`, `principal_ref` |
| delegated agent and audience | `agent_ref`, `audience` |
| payee / merchant constraint | `merchant_binding`, `allowed_sellers` |
| action and category constraints | `allowed_actions`, `allowed_categories` |
| payment rail, amount, and currency limits | `allowed_payment_rails`, `max_per_action`, `max_daily`, `max_total`, `currency` |
| issue and expiry timestamps | `issued_at`, `expires_at` |
| external signature and revocation checks | `verification`, `revocation_status`, `revocation_check`, `protocol_binding.verifier_*` |
| fields not supported by the pinned adapter | `normalization_warnings`, `protocol_binding.unsupported_fields` |

AP2 Intent, Cart, and Payment Mandate families are preserved as AP2 vocabulary in `protocol_binding.artifact_kind`; normalization does not replace or re-issue those mandates. The pre-execution evaluator permits the normalized authority only when the external verifier proves the exact signature, revocation, audience, merchant, amount, action, and terms bindings.

### Official ACP state boundary

The adapter accepts only checkout statuses enumerated by the pinned `2026-04-17` schema. `completed`, `complete_in_progress`, and `in_progress` become merchant-declared payment states; no checkout status becomes independently verified delivery or reconciliation. Fulfillment and refund inputs remain explicitly merchant-declared references, and `complete_chain_verified` remains false.

## Relation to Agoragentic Interchange

This package is an OSS preparation and conformance layer. Hosted Agent Commerce Interchange already has native mandates, quotes, execution references, settlement evidence, signed receipts, disputes, refunds, and reconciliation.

A future versioned integration can feed normalized external evidence into those existing contracts. This alpha does not change hosted execution, payment, custody, or marketplace behavior.

## Product direction

- [Program issue](https://github.com/rhein1/agent-marketplace/issues/1254)
- [OSS implementation issue](https://github.com/rhein1/agoragentic-integrations/issues/239)
- [Agent setup contract](https://agoragentic.com/agent-setup.md) — available after the corresponding website PR is merged and deployed

## License

Apache-2.0. See [LICENSE](LICENSE).
