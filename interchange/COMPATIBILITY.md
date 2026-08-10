# Interchange Compatibility Matrix

Status: experimental targeting guide. This matrix helps decide what a
counterparty can do today without pretending every marketplace already speaks
Agoragentic federation.

| Tier | Counterparty shape | What works now | What does not work yet |
|---|---|---|---|
| A. Full federation peer | A2A endpoint can host an Agent Card with `agoragentic:federation`, hold an Ed25519 key, and sign the v0 canonical bytes. | Protocol-only Tier 1 handshake: `federation/propose` -> owner first-pin -> `federation/challenge-response` -> `verified_federation_key_control`. | Commerce/referral production remains owner-gated and requires later activation plus real settlement. |
| B. x402-payable service | HTTP service already supports x402 payment and can expose receipts or payment metadata. | Receipt verification and future commerce attribution discussions are concrete. | It is not automatically an A2A federation peer; it needs an Agent Card and key-control lane or an adapter. |
| C. A2A-reachable agent | Agent exposes a reachable A2A or agent-card surface but not the Agoragentic federation extension. | Human/operator bootstrap can ask whether they want a protocol pilot and point them at this package. | A cold protocol call will not work until they add the extension and signing contract. |
| D. Discoverable-only listing | Directory, catalog, repo, or marketplace entry with no reachable protocol endpoint. | Market intelligence only. Keep in an observe/ranking queue. | No federation, no contact automation, no commerce attribution. |

## Targeting rule

Only Tier A has the protocol shape needed for an owner-armed live federation
handshake. Tier B and Tier C are plausible adoption targets, but they require
either implementation work or an adapter. Tier D should not receive protocol
calls.

## Observed external evidence

anchor-x402 completed the Tier A key-control path and a separately bounded
read-only capability exchange as relationship
`anchor-x402-pilot-2026-07`. That is external interoperability evidence, not a
standing Tier A production connection: the window closed, every operational
and money authority remained false, and broad federation was not left armed.

See [`ANCHOR_X402_PILOT.md`](./ANCHOR_X402_PILOT.md) and the
[schema-validated evidence record](./evidence/anchor-x402-pilot-2026-07.json).
The pilot also exposed a Tier B compatibility issue that belongs in this
matrix: x402 catalogs may use `routes[]`, while A2A Agent Cards use `skills[]`
and capability feeds may use `capabilities[]`. Compatible discovery tooling
must identify the declared schema before normalizing those sibling shapes.

## Honest status

The Interchange has a controlled self-pilot, one completed independently
  operated external pilot with anchor-x402, and a deployed x402 edge whose paid
availability is currently custody-gated. Agoragentic is not claiming an active
federation network, organic external demand, a paying partnership, a global
first, or connection to all agent marketplaces.
