# Interchange Production Chronology

This chronology covers the Agent Commerce Interchange program from its formal
charter on 2026-06-08 through the production snapshot on 2026-08-14. Earlier
x402 work is treated as prehistory unless it is needed to explain a later
Interchange decision.

Pull-request links prove merged source. They do not, by themselves, prove
deployment, activation, external exercise, adoption, or revenue.

## Program boundary

- **2026-06-08:** [Issue #520](https://github.com/rhein1/agent-marketplace/issues/520)
  opened the formal program: payments, marketplace routing, discovery, receipts,
  and cross-market adoption.
- **2026-06-11:** the issue closed after the foundational contracts entered
  `main`; later production work moved into hardening, activation, external
  validation, and adoption evidence.
- **2026-07-22 onward:** [Issue #1100](https://github.com/rhein1/agent-marketplace/issues/1100)
  became the living GA/adoption gate. It remains open because implemented and
  externally exercised capability is not the same as organic use, repeat use,
  or retained revenue.

## 2026-06-11 to 2026-06-18: contract, lifecycle, and first settlement proof

| Date | Source change | Evidence level and significance |
|---|---|---|
| Jun 11 | [#553](https://github.com/rhein1/agent-marketplace/pull/553), [#602](https://github.com/rhein1/agent-marketplace/pull/602) | `source_merged`: core contracts, the 12-state lifecycle, receipts, disputes, discovery, and external surfaces. |
| Jun 12 | [#627](https://github.com/rhein1/agent-marketplace/pull/627), [#644](https://github.com/rhein1/agent-marketplace/pull/644), [#652](https://github.com/rhein1/agent-marketplace/pull/652) | `source_merged`: cross-market discovery, external x402 rail, activation runbook, status checker, and first source. New authority-bearing flags stayed off. |
| Jun 12 | [#653](https://github.com/rhein1/agent-marketplace/pull/653), [#656](https://github.com/rhein1/agent-marketplace/pull/656), [#657](https://github.com/rhein1/agent-marketplace/pull/657) | Corrected three early honesty/interoperability gaps: invalid A2A card shape, noncanonical x402 requirements, and a receipt-signing source that had been overstated. |
| Jun 14 | [#672](https://github.com/rhein1/agent-marketplace/pull/672) | `first_party_exercised`: an Agoragentic canary paid an external seller 0.005 USDC on Base. It proved the outbound rail, not external demand; its receipt was unsigned and therefore later rejected by the hardened verifier. |
| Jun 15 | [#681](https://github.com/rhein1/agent-marketplace/pull/681) | `source_merged`: cold x402 buyer discovery was made actionable. |
| Jun 17-18 | [#716](https://github.com/rhein1/agent-marketplace/pull/716), [#720](https://github.com/rhein1/agent-marketplace/pull/720) | Closed an A2A governance bypass by routing A2A invoke through the shared governed invocation core. |
| Jun 18 | [#731](https://github.com/rhein1/agent-marketplace/pull/731), [#734](https://github.com/rhein1/agent-marketplace/pull/734), [#739](https://github.com/rhein1/agent-marketplace/pull/739) | Refused canary spend when receipts would be unsigned, hardened settlement/receipt gates, and bound external x402 uniqueness to the on-chain transaction hash. |

## 2026-07-06 to 2026-07-13: money safety and external buyer interoperability

| Date | Source change | Evidence level and significance |
|---|---|---|
| Jul 6 | [#924](https://github.com/rhein1/agent-marketplace/pull/924), [#926](https://github.com/rhein1/agent-marketplace/pull/926) | Re-landed discovery-honesty and money-safety changes lost during an earlier redaction/integration sequence. |
| Jul 8 | [#931](https://github.com/rhein1/agent-marketplace/pull/931), [#933](https://github.com/rhein1/agent-marketplace/pull/933), [#934](https://github.com/rhein1/agent-marketplace/pull/934) | Fixed payout idempotency, idempotent invoke charging, and PostgreSQL execution fail-closed behavior. |
| Jul 8 | [#981](https://github.com/rhein1/agent-marketplace/pull/981), [#982](https://github.com/rhein1/agent-marketplace/pull/982), [#983](https://github.com/rhein1/agent-marketplace/pull/983), [#984](https://github.com/rhein1/agent-marketplace/pull/984), [#985](https://github.com/rhein1/agent-marketplace/pull/985) | Documented partner x402 invocation binding and added settlement transaction hashes, honest stale-sync status, a bounded sandbox mandate, and an isolated CAIP-2 x402 dialect endpoint. |
| Jul 9 | [#990](https://github.com/rhein1/agent-marketplace/pull/990) | Removed live API keys duplicated into quickstart/starter-pack command examples and added count-based regression tests. |
| Jul 9 | [#991](https://github.com/rhein1/agent-marketplace/pull/991), [#996](https://github.com/rhein1/agent-marketplace/pull/996) | Allowed first-party-card plans using x402-per-request to pass payment preparation without an internal balance, and retained the authenticated agent as buyer while recording the paying wallet separately. |
| Jul 11 | [#977](https://github.com/rhein1/agent-marketplace/pull/977) | Isolated federation administration behind a distinct credential. |
| Jul 12 | [#1004](https://github.com/rhein1/agent-marketplace/pull/1004), [#1006](https://github.com/rhein1/agent-marketplace/pull/1006), [#1007](https://github.com/rhein1/agent-marketplace/pull/1007), [#1008](https://github.com/rhein1/agent-marketplace/pull/1008) | Added one discovery-sync leader, atomic x402 eligibility claims, stronger Agreements Phase B evidence, and CAIP-2 arbiter/CORS wiring. |
| Jul 12 | External modern-client run | `recruited_external_exercised`: a recruited independent buyer used an unmodified modern EVM x402 client against the CAIP-2 endpoint. Base transaction [`0x705c...6e95`](https://basescan.org/tx/0x705c7a146774289c9e26aea991eac31c82bede037f497b4994bf3d32bbcc6e95) transferred 0.01 USDC from the buyer wallet to the platform settlement wallet and succeeded in block 48,548,710. This proves interoperability and settlement, not organic demand or retained revenue. |
| Jul 13 | [#1012](https://github.com/rhein1/agent-marketplace/pull/1012), [#1013](https://github.com/rhein1/agent-marketplace/pull/1013) | Added a fail-closed declared-versus-derived signer check and a default-off CDP signer backend after the configured signer was found not to control the settlement wallet. |

## 2026-07-16 to 2026-07-18: custody migration and fail-closed availability

| Date | Source change | Evidence level and significance |
|---|---|---|
| Jul 16-17 | [#1023](https://github.com/rhein1/agent-marketplace/pull/1023), [#1031](https://github.com/rhein1/agent-marketplace/pull/1031), [#1032](https://github.com/rhein1/agent-marketplace/pull/1032), [#1033](https://github.com/rhein1/agent-marketplace/pull/1033), [#1036](https://github.com/rhein1/agent-marketplace/pull/1036) | Added an authoritative custody freeze, explicit replacement-NFT ownership, truthful/reachable frozen discovery, freeze-aware deploy verification, and configured Base RPC use for custody contracts. |
| Jul 18 | [#1037](https://github.com/rhein1/agent-marketplace/pull/1037), [#1038](https://github.com/rhein1/agent-marketplace/pull/1038) | Recorded a 1 USDC V2 treasury payout canary and separated expected custody policy from 5xx failure accounting. The canary proved control of the new CDP signer; production was re-frozen afterward. |

The custody migration was deliberately kept separate from the recruited buyer
tests. Historical payment capability therefore remains proved while current paid
availability can honestly be unavailable under the freeze.

## 2026-07-18 to 2026-07-24: federation, Anchor, and outreach instrumentation

| Date | Source change | Evidence level and significance |
|---|---|---|
| Jul 18-20 | [#1041](https://github.com/rhein1/agent-marketplace/pull/1041), [#1051](https://github.com/rhein1/agent-marketplace/pull/1051), [#1054](https://github.com/rhein1/agent-marketplace/pull/1054), [#1072](https://github.com/rhein1/agent-marketplace/pull/1072), [#1074](https://github.com/rhein1/agent-marketplace/pull/1074) | Added a default-off daily A2A scheduler, reciprocal identity preflight, isolated federation identity key loading, stable error handling, and a valid identity manifest. |
| Jul 21 | [#1083](https://github.com/rhein1/agent-marketplace/pull/1083), [#1086](https://github.com/rhein1/agent-marketplace/pull/1086), [#1088](https://github.com/rhein1/agent-marketplace/pull/1088) | Built the async challenge relay, published its request-auth contract and expiry behavior, and made Agent Card evidence hashes reproducible. |
| Jul 21 | [#1090](https://github.com/rhein1/agent-marketplace/pull/1090), [#1091](https://github.com/rhein1/agent-marketplace/pull/1091), [#1095](https://github.com/rhein1/agent-marketplace/pull/1095) | Added bounded first contact, PostgreSQL draft persistence, and durable scheduler-run evidence. |
| Jul 22 | [#1103](https://github.com/rhein1/agent-marketplace/pull/1103), [#1104](https://github.com/rhein1/agent-marketplace/pull/1104), [#1107](https://github.com/rhein1/agent-marketplace/pull/1107) | Launched the public Interchange page and added the bounded capability-exchange canary with active-binding lifetime enforcement. |
| Jul 21-23 | Bounded first-contact observation | One live first contact per UTC day reached `moltrust.ch`, `netlify.app`, and `vercel.app`. No response qualified as valid A2A engagement. Delivery alone was not counted as engagement. |
| Jul 22-23 | Anchor Phase 1 and 2 | `independent_external_exercised`: dedicated Ed25519 key control was verified under TOFU, then both operators completed a 24-hour read-only capability exchange under explicit request budgets. No operational or money authority persisted. See [`../ANCHOR_X402_PILOT.md`](../ANCHOR_X402_PILOT.md). |
| Jul 22-24 | [#1110](https://github.com/rhein1/agent-marketplace/pull/1110), [#1115](https://github.com/rhein1/agent-marketplace/pull/1115), [#1123](https://github.com/rhein1/agent-marketplace/pull/1123), [#1124](https://github.com/rhein1/agent-marketplace/pull/1124), [#1125](https://github.com/rhein1/agent-marketplace/pull/1125), [#1128](https://github.com/rhein1/agent-marketplace/pull/1128) | Fixed benign-copy false positives, candidate/probe integrity, plural catalog shapes, lock-contention retry, and recorded the production retry result. |

## 2026-07-25 to 2026-08-08: conversations, consent, and negative evidence

| Date | Source change | Evidence level and significance |
|---|---|---|
| Jul 25 | [#1132](https://github.com/rhein1/agent-marketplace/pull/1132), [#1136](https://github.com/rhein1/agent-marketplace/pull/1136), [#1141](https://github.com/rhein1/agent-marketplace/pull/1141) | Hardened daily candidate audit, added an owner-reviewed onboarding kit, and owner notification for pending review. |
| Jul 26 | [#1159](https://github.com/rhein1/agent-marketplace/pull/1159), [#1160](https://github.com/rhein1/agent-marketplace/pull/1160), [#1165](https://github.com/rhein1/agent-marketplace/pull/1165) | Added a durable bounded conversation lane, separated transport delivery from engagement, and required live consent beyond registry projection. |
| Jul 27-28 | [#1170](https://github.com/rhein1/agent-marketplace/pull/1170), [#1171](https://github.com/rhein1/agent-marketplace/pull/1171), [#1173](https://github.com/rhein1/agent-marketplace/pull/1173) | Completed protocol bindings from live cards, hardened opt-in evidence, and added an encrypted correspondence-relay contract. |
| Jul 29-Aug 4 | Seven-window post-fix observation | Zero live first-contact sends and zero valid A2A engagement. Eligibility failed closed on missing consent, unsupported protocol versions, endpoint-origin mismatch, invalid bindings or Agent Cards, unreachable endpoints, cooldowns, and `no_eligible_draft`. This is a negative result about candidate/source compatibility, not proof that the scheduler failed to run. |
| Aug 1-2 | [#1212](https://github.com/rhein1/agent-marketplace/pull/1212), [#1213](https://github.com/rhein1/agent-marketplace/pull/1213), [#1222](https://github.com/rhein1/agent-marketplace/pull/1222) | Failed closed on source-definition drift, aligned paid discovery with custody freeze, and hardened outreach evidence. |
| Aug 8 | [#1234](https://github.com/rhein1/agent-marketplace/pull/1234) | Accepted a standard contact-consent extension without treating its absence as permission. |

## 2026-08-09 to 2026-08-14: source quality and principal authority

| Date | Source change | Evidence level and significance |
|---|---|---|
| Aug 9 | [#1281](https://github.com/rhein1/agent-marketplace/pull/1281) | Added AgentSystems candidate qualification. The source remained provenance-only and did not supply contact authority. |
| Aug 10 | [#1296](https://github.com/rhein1/agent-marketplace/pull/1296) | Added a Global A2A Registry provenance reader, default-off and non-authoritative. |
| Aug 12 | [#1299](https://github.com/rhein1/agent-marketplace/pull/1299) | Added a consented inbound operator-intake lane, merged default-off. |
| Aug 12 | [#1302](https://github.com/rhein1/agent-marketplace/pull/1302), [#1303](https://github.com/rhein1/agent-marketplace/pull/1303), [#1304](https://github.com/rhein1/agent-marketplace/pull/1304), [#1306](https://github.com/rhein1/agent-marketplace/pull/1306), [#1308](https://github.com/rhein1/agent-marketplace/pull/1308) | Added explicit principal authority grants, reserved-wallet authority, authenticated x402 settlement authority, assurance records, and paid-route enforcement. |
| Aug 13 | [#1312](https://github.com/rhein1/agent-marketplace/pull/1312), [#1319](https://github.com/rhein1/agent-marketplace/pull/1319) | Added and activated a bounded Official MCP Registry discovery source. One successful 50-record run is proved; the second 24-hour cadence proof was still pending at this record's 2026-08-14T20:00Z snapshot. |
| Aug 14 | [#1326](https://github.com/rhein1/agent-marketplace/pull/1326) | Added a bounded Global A2A source, still disabled at the source-definition level and non-authoritative. |

## Production snapshot at 2026-08-14T20:00Z

- `/api/health`: healthy; source identity intentionally reported `unknown` under
  the current source-fingerprint model.
- `/api/discovery/check`: `PASS 100/100` across 50 artifacts and 62 consistency
  checks.
- Interchange discovery: fresh, live scheduler every six hours, PostgreSQL
  execution and leader guards available. The Official MCP Registry source has
  `min_sync_interval_ms=86400000`, so intervening scheduler ticks skip it rather
  than performing a network fetch.
- Enabled discovery sources: x402scan, Official MCP Registry, and the external
  pack. Imported metadata remains provenance-only.
- Official MCP Registry: first accepted run at
  `2026-08-13T20:32:51.334Z`, run
  `idsync_fe62cd4c-d5f5-449a-94d1-7b2e0b514366`, 50 fetched/imported,
  zero rejected. Second 24-hour-apart proof not yet due at snapshot time.
- Platform custody: authoritatively frozen; outbound money disabled; CDP signer
  ready and address-matched.
- Base and CAIP-2 x402 probes: both `503 platform_custody_frozen`, with no
  challenge issued and no payment settled.
- Broad federation capability feed: `404 federation_capability_feed_not_enabled`.

This snapshot must not be quoted as a permanent availability statement.
