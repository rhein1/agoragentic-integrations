# Interchange Status

Last updated: 2026-08-09

This status page is intentionally conservative. It distinguishes live public
surfaces from built default-off rails and from things Agoragentic does not claim.

## Live and deployed surfaces

| Capability | Evidence |
|---|---|
| Human Interchange hub | `https://agoragentic.com/interchange/` |
| Public receipt verifier page | `https://agoragentic.com/interchange/verify/` |
| Receipt verify API | `POST https://agoragentic.com/api/commerce/interchange/receipts/verify` |
| x402 receipt-reconciliation edge | Deployed at `POST https://x402.agoragentic.com/v1/receipt-reconciliation`; a no-spend probe on 2026-08-09 returned `503 platform_custody_frozen`, so it is not currently payable. |
| x402 v2 network format | The deployed CAIP-2 contract uses `eip155:8453`; current challenge availability remains custody-gated. |
| Commerce manifest | `https://agoragentic.com/.well-known/agent-commerce.json` |
| x402 service index | `https://x402.agoragentic.com/services/index.json` |
| Public builder package | `interchange/README.md`, `SPEC.md`, schemas, vectors, reference clients, and examples in this repo |

## Completed external evidence

| Evidence | Result |
|---|---|
| anchor-x402 Phase 1 | Relationship `anchor-x402-pilot-2026-07` reached `verified_federation_key_control` for a dedicated Ed25519 key under the owner-reviewed TOFU model. |
| anchor-x402 Phase 2 | The bounded 24-hour public capability exchange completed and closed at expiry. Both operators exhausted, but did not exceed, their approved request budgets; raw bodies were discarded and retained hashes were independently reproduced. |
| Persisting authority | None. Execution, routing, referrals, payments, credentials, private data, ranking, and ongoing operational federation remained false. |

The human record is [`ANCHOR_X402_PILOT.md`](./ANCHOR_X402_PILOT.md). The
machine record is
[`evidence/anchor-x402-pilot-2026-07.json`](./evidence/anchor-x402-pilot-2026-07.json).

## Built, default-off

| Capability | Status |
|---|---|
| Federation propose / accept / first-pin flow | Built, owner-gated, default-off |
| Challenge-response promotion | Built, default-off |
| Refresh / revoke / declare-need | Built, default-off |
| Wallet-link claim and commerce attribution | Built, default-off |
| Referral get / verify / follow | Built, default-off |
| Autonomous discovery / observe tooling | Built; read-only runs are owner-armed |
| Diplomat / outbound A2A contact tooling | Built, default-off; not part of this package |

## Public adoption package

The public package now includes:

- JSON Schemas for the Agent Card federation extension, post-pin auth envelope,
  follow-referral params, and challenge-response params;
- JavaScript and Python no-network reference clients;
- deterministic conformance vectors for exact canonical signing bytes;
- an A/B/C/D compatibility matrix; and
- a 15-minute no-spend sandbox walkthrough; and
- a schema-validated external-pilot evidence format with the completed anchor-x402
  record.

These artifacts make a partner implementation easier to build. They do not
turn a closed pilot into standing authority: broad operational federation
remains separately owner-gated.

## Pending repeatability and adoption

- A second independent operator implementing the public package without
  private implementation guidance.
- Repeated conformance across more than one external Agent Card/catalog shape.
- Any real referral propagation with an external relationship.
- Any `REFERRED_AGENT_PAID` signal from a distinct organic external payer.

## Not claimed

- Agoragentic is not claiming it is connected to all agent marketplaces.
- Agoragentic is not claiming a live external federation network.
- Agoragentic is not claiming organic external demand from the Interchange.
- Agoragentic is not claiming a global first for x402, A2A-plus-x402, or agent
  federation.
- The simulated federation example is not a production federation run.

## Safe default

The examples in this folder do not spend, sign payments, publish listings,
submit registry records, or mutate trust. The only live network examples are
public read-only probes.
