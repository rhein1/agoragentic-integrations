# Interchange Status

Last updated: 2026-08-14T20:00Z

This status page is intentionally conservative. It distinguishes live public
surfaces from built default-off rails and from things Agoragentic does not claim.

## Live and deployed surfaces

| Capability | Evidence |
|---|---|
| Human Interchange hub | `https://agoragentic.com/interchange/` |
| Public receipt verifier page | `https://agoragentic.com/interchange/verify/` |
| Receipt verify API | `POST https://agoragentic.com/api/commerce/interchange/receipts/verify` |
| x402 receipt-reconciliation edge | Deployed at `POST https://x402.agoragentic.com/v1/receipt-reconciliation`; paid availability remains frozen. No-spend Base and CAIP-2 probes at the snapshot returned `503 platform_custody_frozen` with no challenge or settlement. |
| x402 dialects | The historical endpoint uses one `base` accept when payable; the isolated CAIP-2 endpoint uses one `eip155:8453` accept. Both are currently custody-gated. |
| Commerce manifest | `https://agoragentic.com/.well-known/agent-commerce.json` |
| x402 service index | `https://x402.agoragentic.com/services/index.json` |
| Public builder package | `interchange/README.md`, `SPEC.md`, schemas, vectors, reference clients, and examples in this repo |
| Discovery scheduler | Live every six hours with PostgreSQL execution and leader guards. At the snapshot, x402scan, Official MCP Registry, and the external pack were enabled and healthy. The Official MCP source has its own `86400000` ms minimum interval, so six-hour scheduler ticks do not fetch it more than once per day. Imported metadata is provenance-only. |
| Discovery integrity | `/api/discovery/check` returned `PASS 100/100` across 50 artifacts and 62 consistency checks at the snapshot. |

## Completed external evidence

| Evidence | Result |
|---|---|
| anchor-x402 Phase 1 | Relationship `anchor-x402-pilot-2026-07` reached `verified_federation_key_control` for a dedicated Ed25519 key under the owner-reviewed TOFU model. |
| anchor-x402 Phase 2 | The bounded 24-hour public capability exchange completed and closed at expiry. Both operators exhausted, but did not exceed, their approved request budgets; raw bodies were discarded and retained hashes were independently reproduced. |
| Persisting authority | None. Execution, routing, referrals, payments, credentials, private data, ranking, and ongoing operational federation remained false. |

The human record is [`ANCHOR_X402_PILOT.md`](./ANCHOR_X402_PILOT.md). The
machine record is
[`evidence/anchor-x402-pilot-2026-07.json`](./evidence/anchor-x402-pilot-2026-07.json).

Separate x402 evidence is documented in
[`research/X402_PRODUCTION_CASE_STUDY.md`](./research/X402_PRODUCTION_CASE_STUDY.md).
The Anchor operator did not make the cited paid-buyer transactions.

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
| Consented inbound operator-intake lane | Built, default-off; a submitted intake grants no federation or commerce authority by itself |
| Encrypted correspondence relay | Contract deployed, operational relay separately gated |
| Global A2A Registry source | Bounded source definition merged but source-level configuration remains disabled and non-authoritative |
| Principal authority grants | Enforcement model deployed; no grant is implied by discovery, registration, or this status page |

## Current custody and paid availability

At the snapshot, the authoritative platform custody state was `frozen`, outbound
money was disabled, and the configured CDP signer was ready with
`derived_matches:true`. The correct claim is therefore:

> Historical x402 settlement and recruited external interoperability are proved;
> new paid execution is currently unavailable under the custody freeze.

Do not infer current payability from merged code, old transaction evidence, or a
service-index entry. Re-probe the route before any paid experiment.

## Discovery-source proof

The Official MCP Registry source completed one accepted bounded run at
`2026-08-13T20:32:51.334Z` (run
`idsync_fe62cd4c-d5f5-449a-94d1-7b2e0b514366`), with 50 fetched/imported and
zero rejected. A second run at least 24 hours later was still pending at this
snapshot, so cadence is not claimed here.

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
- A second successful Official MCP Registry run at least 24 hours after the
  first accepted run.
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

The complete production chronology, negative outreach result, x402 settlement
case study, finding ledger, and claim vocabulary are indexed from
[`research/README.md`](./research/README.md).
