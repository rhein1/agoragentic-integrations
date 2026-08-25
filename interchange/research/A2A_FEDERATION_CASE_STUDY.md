# A2A and Federation Production Case Study

## Question

Can two independently operated agent systems prove reciprocal signing-key
control and exchange public capability metadata without granting execution,
routing, referral, payment, or trust authority?

The Anchor pilot answered that narrow question positively. A separate autonomous
outreach observation answered a broader question negatively: discovery sources
did not provide enough live consent and protocol compatibility to create useful
cold A2A conversations safely.

## Protocol boundary

The Interchange uses A2A-compatible cards and JSON-RPC methods, but treats task
RPC, federation identity, contact consent, and commerce authority as separate
concerns.

- An Agent Card can describe an endpoint and capabilities.
- A registry can preserve provenance and help resolve a card.
- Neither grants permission to contact or invoke the described agent.
- A TOFU pin proves control of a presented key under the reviewed relationship;
  it does not prove legal identity or endorsement.
- A challenge response proves key control for a bounded message and time.
- Operational federation requires a separate authority grant.

The design invariant that emerged is:

> The registry observes; it never grants authority. Discoverability is not
> authority.

## Anchor Phase 1: reciprocal key control

Counterparty: `anchor-x402`, an independent operator at
<https://anchor-x402.com>.

The reviewed relationship was:

- relationship: `anchor-x402-pilot-2026-07`;
- remote origin: `https://anchor-x402.com`;
- dedicated key id: `anchor-pilot-2026-01`;
- algorithm: Ed25519;
- key fingerprint:
  `sha256:207d6f543f8d918f9fe7563c5d788d741382c3eed50abbcafb04a0c80c11d212`;
- identity model: owner-reviewed TOFU plus challenge response; and
- retained operational authority: none.

The dedicated federation key was explicitly separate from treasury, x402, and
administrative authority. Agoragentic also used a dedicated federation identity
key and isolated federation-admin credential.

### Challenge path defects found in production

The first successful handshake required several corrections:

1. the initial enablement window was not actually live when the partner tried;
2. a five-minute challenge lifetime was incompatible with human operator
   coordination;
3. the request-challenge authentication schema and exact signed bytes were not
   published;
4. structurally invalid auth and bad signatures collapsed into one generic
   error;
5. a PostgreSQL `23505` unique-violation escaped through the API;
6. challenge creation used multiple writes without the required transactional
   behavior; and
7. an Agent Card evidence hash could not be reproduced without documenting the
   historical JSON-stringified-response recipe.

The relay contract, error taxonomy, challenge retirement, transactional
behavior, pull delivery, and versioned hash recipes were corrected before the
final handshake. The relationship reached
`verified_federation_key_control`. That state means verified control of the
pinned key, not legal identity and not permission to execute work.

## Anchor Phase 2: bounded capability exchange

The operators then approved a 24-hour read-only experiment:

- window: `2026-07-22T22:35:53.495Z` through
  `2026-07-23T22:35:53.495Z`;
- maximum four planned pulls per origin;
- Agoragentic used four platform request slots plus one separately disclosed and
  operator-approved diagnostic GET;
- Anchor used four GETs;
- public Agent Card and catalog fields only;
- raw response bodies discarded after normalization;
- retained data limited to normalized public fields, versioned hashes,
  timestamps, trap-scan metadata, and revocation state; and
- execution, routing, referrals, payments, credentials, private data, ranking,
  and partnership claims prohibited.

Both operators performed a paired pull, waited, and performed a paired refresh.
Hashes changed only with observable public metadata changes. Each operator
reproduced the other's retained hashes. The immutable time gate closed the feed
at expiry, and the key-control relationship remained while the canary authority
ended.

The full public record is:

- [`../ANCHOR_X402_PILOT.md`](../ANCHOR_X402_PILOT.md); and
- [`../evidence/anchor-x402-pilot-2026-07.json`](../evidence/anchor-x402-pilot-2026-07.json).

### Catalog-shape finding

Anchor's A2A card exposed standard `skills[]`, while its x402 discovery catalog
used `routes[]`. Agoragentic's own feed used `capabilities[]`. A normalizer that
understood only one family returned zero rows without actually suppressing any
fields. The fix was to treat `skills[]`, `routes[]`, and `capabilities[]` as
sibling public catalog shapes.

This is ecosystem-relevant: successful HTTP retrieval and a valid hash do not
prove semantic interoperability.

## Autonomous first-contact observation

The outreach system was intentionally bounded:

- maximum one live A2A first contact per UTC day;
- durable identity/domain deduplication;
- no money, provider execution, routing, referral, or broad federation
  authority;
- conversation scheduling could not create new contacts or widen consent; and
- HTTP 2xx or an empty response counted as delivery without engagement unless a
  valid A2A Message/Task, durable callback/task/follow-up event, or separately
  recorded operator response existed.

### Pre-fix observation

One live first contact was attempted on each of 2026-07-21, 2026-07-22, and
2026-07-23, to `moltrust.ch`, `netlify.app`, and `vercel.app`. None produced
valid A2A engagement.

### Post-fix observation

After the live-card protocol-binding fix entered production, the intended
2026-07-29 through 2026-08-04 windows produced zero live sends. The system
failed closed because sampled candidates lacked one or more of:

- authoritative live contact consent;
- a supported protocol version;
- matching endpoint and origin;
- a valid protocol binding;
- valid Agent Card JSON;
- a reachable endpoint; or
- eligibility after the failed-probe cooldown.

The fixed audit window after `2026-08-02T15:01:46.327Z` recorded 1,613 durable
scheduler rows but zero live attempts, sends, deliveries, valid engagements,
conversations, task events, or federation-state changes. The row count mainly
demonstrates scheduler/audit activity; it must not be presented as outreach
volume.

## What the evidence proves

- Independent operators can complete the published Ed25519 key-control contract.
- A bounded, revocable, public-only capability exchange can close automatically
  without retaining broad authority.
- Hash recipes must define exact bytes, not just an algorithm name.
- Catalog normalizers must handle multiple protocol-native shapes.
- Durable outreach accounting can distinguish scheduler activity, delivery, and
  engagement.
- A fail-closed consent policy prevents registry discovery from becoming
  unsolicited invocation authority.

## What the evidence does not prove

- legal identity of either operator from the cryptographic proof alone;
- standing operational federation;
- useful autonomous cold outreach;
- external task routing or referral propagation;
- organic adoption; or
- any payment or revenue from the Anchor pilot.

## Design implications

1. **Separate discovery, contact, and invoke consent.** Each should have scope,
   issuer, subject, expiry, and revocation.
2. **Use durable threads for correspondence.** A2A task completion is not a
   durable peer inbox.
3. **Keep inbound operator intake distinct from cold outreach.** An operator who
   explicitly submits a federation request supplies stronger consent evidence
   than a registry projection.
4. **Do not increase fleet size before candidate quality improves.** More agents
   cannot repair invalid cards, missing consent, or protocol mismatches.
5. **Preserve negative evidence.** Zero eligible sends under a fail-closed policy
   is a safety result and a source-quality finding, not zero system activity.
