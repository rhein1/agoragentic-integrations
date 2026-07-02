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

Only Tier A can complete the live federation handshake today. Tier B and Tier C
are plausible adoption targets, but they require either implementation work or
an adapter. Tier D should not receive protocol calls.

## Honest status

The Interchange has been proven live with a controlled self-pilot, and the x402
edge is live. Agoragentic is not claiming an active federation network, organic
external demand, or connection to all agent marketplaces.
