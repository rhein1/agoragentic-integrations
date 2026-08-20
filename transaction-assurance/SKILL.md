---
name: agoragentic-transaction-assurance
description: Prepare, evaluate, and reconcile autonomous agent transactions without self-granting payment or owner authority. Use when an agent must bind principal authority, seller terms, payment evidence, execution, delivered outcome, and reconciliation; handle paid retries safely; or prepare an authority request for owner review.
---

# Agoragentic Transaction Assurance

Use this skill when a task involves an autonomous agent buying work, invoking a paid API or MCP tool, using delegated payment authority, validating delivery, reconciling an ambiguous result, or preparing a refund/dispute evidence packet.

## Core rule

**Payment evidence proves that money moved. It does not by itself prove that the authorized job ran or that the promised outcome was delivered.**

Build and evaluate one evidence chain:

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

## Authority boundary

You may autonomously:

- inspect public schemas and current availability;
- install and run the local no-network assurance package;
- detect a protocol family;
- normalize an artifact as `unverified`;
- create a proposal-only authority request;
- build a transaction-assurance envelope;
- evaluate an envelope;
- request missing evidence;
- prepare a refund or dispute packet without filing it.

You may not autonomously:

- invent or impersonate the principal;
- approve your own authority request;
- increase budget or expand merchant, category, action, rail, currency, or time scope;
- fund or debit an owner payment method without delegated authority;
- treat protocol recognition or parsed fields as signature verification;
- retry an ambiguous paid call without the same idempotency/payment identifiers and reconciliation evidence;
- declare `reconciled` while required authority, payment, execution, delivery, validation, or finality evidence is missing;
- expose private keys, seed phrases, card data, payment credentials, raw prompts, raw tool output, wallet-private data, or private owner data.

## First action

Before a paid action, inspect the current platform/rail availability and the source authority artifact. Unknown availability or authority means **no spend**.

For Agoragentic-hosted setup, read:

```text
https://agoragentic.com/agent-bootstrap.json
https://agoragentic.com/agent-setup.md
```

For local repository work:

```bash
cd transaction-assurance
npm run self-test
```

## Workflow

### 1. Detect, but do not verify by recognition

```bash
node bin/agora-assure.mjs detect authority.json
```

Supported structural profiles include native Agoragentic mandates, AP2, Visa TAP, official OpenAI/Stripe ACP, x402, Circle Agent Wallet policy evidence, Skyfire KYA/KYAPay, and Verifiable Intent markers.

A detection result describes structure only. Do not change verification status from `unverified` unless a version-specific verifier produced evidence.

### 2. Normalize the authority artifact

```bash
node bin/agora-assure.mjs normalize authority.json \
  --artifact-ref vault://authority/123 \
  --verification-status unverified \
  --revocation-status not_checked
```

Store a reference and stable hash, not the raw private artifact.

Fail closed when any required field is unknown:

- principal or agent identity;
- issuer/signature verification;
- audience or merchant binding;
- issue/expiry;
- revocation;
- action, seller, category, rail, currency, or amount limits.

### Optional: bind Mycelium public anchor evidence

Use the local `external-verification-adapters` export only when a transaction already carries the exact pinned Mycelium action-reference v1 profile and a separately reviewed host can supply public AnchorRegistry observations through the trusted synchronous callback boundary.

The adapter is no-network and read-only. A `checked_match` proves only reference anchoring, public block timestamp, and event inclusion. It does not prove principal authority, execution correctness, delivery, settlement, or single execution, and it never grants spend, execution, deployment, publication, or trust authority. Keep `authenticated_action_ref` and delivery/payment/reconciliation state independent from `external_action_refs` and `external_verification`.

See `docs/MYCELIUM_EXTERNAL_VERIFICATION.md` for immutable pins, the callback contract, and the exact claim boundary.

### 3. Prepare authority for owner review

Use `buildAuthorityRequest()` or:

```bash
node bin/agora-assure.mjs authority-request authority-request-input.json
```

The request must remain:

```text
status = pending_principal_approval
approval = null
request_grants_authority = false
all authority flags = false
```

Send the request through an approved owner-control channel. Do not edit it into an approval.

### 4. Build the pre-execution envelope

Bind:

- principal and agent;
- verified source authority;
- exact action;
- seller, capability, category, quote, and terms;
- payment rail, amount, and payment identifier;
- idempotency key hash;
- input hash;
- required outcome validators;
- expected reconciliation behavior.

Use decimal strings for money. Preserve explicit unknowns.

### 5. Evaluate before execution

```bash
node bin/agora-assure.mjs evaluate envelope.json --phase pre_execution
```

Interpret decisions precisely:

- `allow`: the local pre-execution contract passed; re-check live rail availability before acting;
- `review`: evidence is missing or ambiguous; request it and re-evaluate;
- `deny`: authority, scope, terms, amount, merchant, rail, expiry, revocation, or replay failed.

`allow` is not a payment signature, owner approval, execution, or guarantee.

### 6. Execute once under the approved identifiers

Keep the same transaction, idempotency, and payment identifiers. Save returned references before doing anything else.

If the call times out or the connection drops, do not blindly retry. Check payment, invocation, receipt, and reconciliation state first.

### 7. Add post-execution evidence

Record references and hashes for:

- payment offer/challenge and receipt;
- verified settlement and finality;
- invocation and attempts;
- input and output;
- returned artifacts;
- seller delivery attestation;
- independent validators;
- refund/dispute state;
- unresolved unknowns.

A seller attestation is not automatically independent verification.

### 8. Evaluate the complete chain

```bash
node bin/agora-assure.mjs evaluate envelope.json --phase post_execution
```

`complete_chain_verified=true` requires all configured authority, terms, payment, execution, outcome, and reconciliation gates to pass.

When payment succeeded but delivery failed, preserve `payment_observed` or `failed`, request missing seller/validator evidence, and prepare the configured refund/dispute path.

When delivery succeeded but settlement is not verified and final, do not mark the seller paid or the transaction reconciled.

## Required final report

```text
Protocol profile: ...
Protocol verification: verified | unverified | failed | unknown
Authority: active | expired | revoked | unknown
Terms: match | changed | unknown
Payment: not started | submitted | observed | settled | failed | refunded | unknown
Execution: not started | pending | success | failed | timed out | ambiguous
Outcome: not observed | partial | delivered | failed | unknown
Outcome verification: verified | unverified | failed | unknown
Reconciliation: not started | pending | complete | failed | refunded | disputed | unknown
Complete chain verified: true | false
Blockers: [...]
Unknowns: [...]
Next safe action: ...
Authority granted by this report: false
```

Never include secret values in the report.
