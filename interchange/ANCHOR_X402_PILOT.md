# Anchor x402 External Interoperability Pilot

**Status:** completed and closed. This is a historical interoperability record,
not an active authority grant.

Anchor x402 was the first independently operated external counterparty to
complete Agoragentic's federation key-control pilot and bounded read-only
capability exchange. The counterparty operated its own HTTPS origin, x402
catalog, Agent Card, and dedicated Ed25519 federation key. Agoragentic did not
hold that private key.

The machine-readable evidence record is
[`evidence/anchor-x402-pilot-2026-07.json`](./evidence/anchor-x402-pilot-2026-07.json).
Its strict schema is
[`schemas/external-pilot-evidence.schema.json`](./schemas/external-pilot-evidence.schema.json).

## What the pilot proved

### Phase 1: reviewed origin and key control

- Relationship: `anchor-x402-pilot-2026-07`
- Remote origin: <https://anchor-x402.com>
- Public Agent Card:
  <https://anchor-x402.com/.well-known/agent-card.json>
- Public x402 catalog: <https://anchor-x402.com/.well-known/x402.json>
- Dedicated key id: `anchor-pilot-2026-01`
- Key algorithm: Ed25519
- Result: `verified_federation_key_control`

The result proves control of the dedicated key published for the reviewed
origin under the Interchange TOFU model. It does not prove legal identity,
endorsement, payment authority, or control of any treasury key.

### Phase 2: bounded public capability exchange

The operators agreed to one immutable 24-hour window from
`2026-07-22T22:35:53.495Z` through `2026-07-23T22:35:53.495Z`.

- Anchor used its agreed four public GETs.
- Agoragentic used four platform request slots plus one separately disclosed
  and operator-approved diagnostic GET, for five actual GETs to Anchor.
- Only public Agent Card and x402 catalog fields were normalized.
- Raw response bodies were discarded after normalization.
- Both operators independently reproduced the retained content hashes.
- The public feed closed at the immutable expiry boundary.

No capability was invoked. No provider was called. No route, referral, ranking,
credential, private data, payment, or settlement authority was granted.

## Evidence basis

The record combines Agoragentic's durable canary identifiers, immutable window,
and request counters with the counterparty operator's completion and
cross-hash-verification receipts. Raw bodies were deliberately discarded under
the agreed privacy boundary, so the live URLs above are current references, not
claims that today's bytes equal the historical snapshots.

## Why the x402 context matters

Anchor was not a synthetic in-process peer. It was an independently operated
x402 service origin with its own Agent Card and catalog. The pilot therefore
tested whether two separately controlled agent-commerce operators could bind a
dedicated federation key, exchange bounded public metadata, preserve evidence,
and close the window without extending that proof into money or execution.

That is materially stronger than a self-pilot or a local conformance fixture.
It is still a recruited interoperability pilot, not organic demand or a paying
partnership.

## Priority claim boundary

This record makes one priority claim: Anchor was **Agoragentic's first external
federation pilot**. It does not claim that Agoragentic or Anchor invented x402,
implemented the first A2A-plus-x402 system, or completed the first agent
federation globally. Public A2A and x402 projects predate this record, and a
global priority claim would require evidence this project does not have.

The defensible description is:

> An early, independently operated and publicly documented x402/A2A
> interoperability pilot with reproducible key-control and bounded
> capability-exchange evidence.

## Findings that improved the profile

1. **Hash recipes must be versioned.** The original Agent Card evidence used a
   JSON-stringified-response recipe that was not obvious to a third-party
   verifier. The operators later documented and reproduced both that historical
   recipe and the v2 raw-body recipe. Historical evidence was not rewritten.
2. **Catalog shapes are plural.** Anchor's x402 catalog used `routes[]`, while
   the first normalizer looked for `capabilities[]`. The implementation later
   added `routes[]` support alongside A2A `skills[]` and capability-feed
   `capabilities[]`. The original zero-row result remains labeled as such.

These findings are part of the value of the pilot. The record is not presented
as a flawless first attempt.

## What remains unproven

- repeatable interoperability with multiple independent operators;
- operational cross-market routing or referrals;
- organic external demand or repeat paid use;
- independent legal-identity attestation; and
- a stable ecosystem standard accepted outside Agoragentic.

The next milestone is a second independent implementation using the public
schema and conformance vectors without private implementation guidance.
