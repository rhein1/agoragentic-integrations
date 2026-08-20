# Production Findings Ledger

This ledger records material defects and design gaps found while the Interchange
was being deployed and externally exercised. A linked pull request proves the
fix entered source. Runtime proof, where available, is described separately.

Severity is retrospective and scoped to the Interchange experiment, not a claim
about a formal incident-response classification.

## Protocol and discovery shape

| ID | Finding | Production consequence | Correction | Residual limit |
|---|---|---|---|---|
| P-01 | The first A2A card and `agents.json` output were not parseable by standard clients. | Discovery existed but interoperable discovery did not. | [#653](https://github.com/rhein1/agent-marketplace/pull/653) emitted spec-valid shapes. | A valid card still grants no contact or invoke consent. |
| P-02 | The x402 challenge was not canonical `PaymentRequirements`. | Standard buyers could discover the route but not pay it. | [#656](https://github.com/rhein1/agent-marketplace/pull/656) aligned the challenge. | Network-dialect compatibility remained separate. |
| P-03 | Current EVM clients expected `eip155:8453`, while the existing edge used `base`. | A modern buyer required client-side normalization. | [#985](https://github.com/rhein1/agent-marketplace/pull/985), [#1008](https://github.com/rhein1/agent-marketplace/pull/1008), and [#1010](https://github.com/rhein1/agent-marketplace/pull/1010) added, governed, and advertised an isolated CAIP-2 endpoint. | Two endpoints must remain behaviorally consistent without mixing dialects. |
| P-04 | Catalog normalizers assumed one array shape. | Anchor's `routes[]` catalog normalized to zero rows despite valid retrieval. | [#1124](https://github.com/rhein1/agent-marketplace/pull/1124) treats `skills[]`, `routes[]`, and `capabilities[]` as sibling shapes. | Future ecosystems can introduce additional shapes. |
| P-05 | Benign catalog copy such as "call, no API" triggered instruction-like scanning. | A public-only exchange failed closed on marketing text. | [#1110](https://github.com/rhein1/agent-marketplace/pull/1110) narrowed normalization while preserving trap scanning. | Text from remote catalogs remains data, never instructions. |
| P-06 | Discovery-source definitions could drift from stored records. | Stale records could remain apparently current under changed source configuration. | [#1212](https://github.com/rhein1/agent-marketplace/pull/1212) invalidates or stales mismatched definitions. | Source health and source authority are still separate. |
| P-07 | The current Official MCP Registry wrapper/schema differed from the original adapter assumption. | The source could be reachable but import nothing useful. | [#1312](https://github.com/rhein1/agent-marketplace/pull/1312) added bounded wrapper compatibility; [#1319](https://github.com/rhein1/agent-marketplace/pull/1319) activated it. | A second 24-hour-apart successful run was pending at the 2026-08-14T20:00Z snapshot. |

## Receipt, settlement, and money safety

| ID | Finding | Production consequence | Correction | Residual limit |
|---|---|---|---|---|
| M-01 | Receipt signing was described as complete while a fallback source could not provide independent receipt verification. | Verification claims exceeded the key model. | [#657](https://github.com/rhein1/agent-marketplace/pull/657) added a dedicated source and corrected the status. | Key custody remains an operational dependency. |
| M-02 | The first outbound x402 canary settled but minted an unsigned receipt. | On-chain payment was real; the application receipt was not independently verifiable. | [#731](https://github.com/rhein1/agent-marketplace/pull/731) refuses spend when a canary would mint unsigned evidence. | The historical run is proved by chain evidence, not by its rejected receipt. |
| M-03 | Settlement and receipt gates accepted incomplete evidence. | A plan could advance without sufficiently bound settlement/receipt facts. | [#734](https://github.com/rhein1/agent-marketplace/pull/734) hardened gates. | Chain truth still needs a network verifier or independently checked receipt. |
| M-04 | External x402 uniqueness was not bound to the chain transaction hash. | Retries or caller-selected references could ambiguously identify one settlement. | [#739](https://github.com/rhein1/agent-marketplace/pull/739) made the transaction hash the uniqueness anchor. | Reorg/finality policy remains chain-specific. |
| M-05 | Seller payout retry semantics were not safely idempotent. | A retry could duplicate or orphan payout effects. | [#931](https://github.com/rhein1/agent-marketplace/pull/931) added idempotent payout behavior. | Every new payout backend needs equivalent proof. |
| M-06 | Invoke retry semantics could charge more than once. | Network retry could become duplicate buyer spend. | [#933](https://github.com/rhein1/agent-marketplace/pull/933) bound charging to idempotent execution state. | Clients still need stable idempotency identifiers where required. |
| M-07 | PostgreSQL execution errors could leave an ambiguous path. | Money-bearing operations risked continuing without durable state. | [#934](https://github.com/rhein1/agent-marketplace/pull/934) made execution errors fail closed. | Database availability can still make the rail unavailable, by design. |
| M-08 | Settlement transaction hashes were absent from edge/main receipt payloads. | A third party could not join application evidence to the chain transaction. | [#982](https://github.com/rhein1/agent-marketplace/pull/982) exposed the hash. | Presence is not verification; callers should still verify it on-chain. |
| M-09 | x402 eligibility was claimed before the reservation was atomic. | Concurrent requests could pass the same precondition. | [#1006](https://github.com/rhein1/agent-marketplace/pull/1006) made eligibility atomic. | Distributed effects still require downstream idempotency. |
| M-10 | Paid discovery did not reflect an authoritative custody freeze. | Buyers could be shown a payable route that could not safely settle. | [#1213](https://github.com/rhein1/agent-marketplace/pull/1213) made paid discovery freeze-aware. | Historical capability must not be described as current availability. |

## Identity, authority, and rail compatibility

| ID | Finding | Production consequence | Correction | Residual limit |
|---|---|---|---|---|
| A-01 | A2A invoke reached a money path outside the shared governed invocation core. | Protocol choice could bypass controls applied to HTTP execute/invoke. | [#716](https://github.com/rhein1/agent-marketplace/pull/716) and [#720](https://github.com/rhein1/agent-marketplace/pull/720) established parity. | New transports must reuse the same authority boundary. |
| A-02 | Payment preparation required internal balance even for `x402_per_request`. | The buyer could not reach the wallet-paid execution it had declared. | [#991](https://github.com/rhein1/agent-marketplace/pull/991) limited the balance precondition to internal-balance plans. | The actual paid step retains settlement and funds gates. |
| A-03 | An authenticated x402 call was attributed to the provisional wallet identity. | Interchange invocation binding failed because mandate buyer and invocation buyer differed. | [#996](https://github.com/rhein1/agent-marketplace/pull/996) retained the agent as buyer and stored the wallet as payer. | Anonymous edge calls still correctly use provisional wallet identity. |
| A-04 | Rail/card incompatibility was detected only deep in the lifecycle. | An external-x402 mandate could target an internal card and fail cryptically later. | [#991](https://github.com/rhein1/agent-marketplace/pull/991) added creation-time compatibility checks. | New rail/card families need explicit compatibility rules. |
| A-05 | Registry inclusion was being used as a candidate signal without authoritative live consent. | Safe outreach either risked unsolicited contact or had to fail closed late. | [#1165](https://github.com/rhein1/agent-marketplace/pull/1165), [#1171](https://github.com/rhein1/agent-marketplace/pull/1171), and [#1234](https://github.com/rhein1/agent-marketplace/pull/1234) require consent evidence. | Public registries generally do not provide that overlay. |
| A-06 | Wallet reservation and authenticated settlement lacked one explicit principal authority model. | Possession of a wallet reference could be confused with authority to spend. | [#1302](https://github.com/rhein1/agent-marketplace/pull/1302), [#1303](https://github.com/rhein1/agent-marketplace/pull/1303), [#1304](https://github.com/rhein1/agent-marketplace/pull/1304), and [#1308](https://github.com/rhein1/agent-marketplace/pull/1308) add and enforce principal-bound grants. | Authority must still be configured and presented; merged code grants none by itself. |
| A-07 | Reconciliation could overstate assurance when evidence bindings, decimal comparisons, time ordering, authority expiry, or unknown outcomes were ambiguous. | A structurally complete record could imply stronger assurance than its facts. | [#1306](https://github.com/rhein1/agent-marketplace/pull/1306) introduced assurance record v3 after six exact-head review fixes. | The pure model still depends on truthful bound inputs. |

## Federation, evidence, and operator coordination

| ID | Finding | Production consequence | Correction | Residual limit |
|---|---|---|---|---|
| F-01 | Federation administration shared the general admin credential. | General-admin exposure could also authorize federation key operations. | [#977](https://github.com/rhein1/agent-marketplace/pull/977) isolated federation administration. | Credential isolation does not replace owner review. |
| F-02 | The initial challenge window and partner-ready specification did not overlap. | The partner reached a disabled relay after implementing the missing contract. | [#1086](https://github.com/rhein1/agent-marketplace/pull/1086) published request auth and retired expired challenges; later pull delivery reduced coordination dependence. | Time-bounded activation still needs observable scheduling. |
| F-03 | Challenge lifetime assumed machine timing despite a human-reviewed TOFU gate. | A five-minute packet expired before an operator could complete the handoff. | The pilot used a longer bounded window and durable pull workflow. | Fully autonomous promotion would require a different authority policy. |
| F-04 | Challenge storage leaked PostgreSQL `23505` and used non-atomic writes. | A legitimate key holder saw an internal SQLSTATE and could not fetch/replace a pending challenge reliably. | The relay handler mapped errors and made challenge insertion transactional before the completed pilot. | Storage taxonomy must remain protocol-level, not database-level. |
| F-05 | The Agent Card evidence hash lacked a reproducible byte recipe. | A hash pinned into relationship evidence could not be checked by the counterparty. | [#1088](https://github.com/rhein1/agent-marketplace/pull/1088) versioned historical and raw-body recipes. | Hashes prove bytes, not semantic truth or identity. |
| F-06 | Challenge packets initially relied on channel trust more than explicit provenance. | The receiver could not fully attribute the packet from its content alone. | The pull relay bound relationship, origin, key, nonce, timestamp, and canonical signed bytes. | TOFU remains operator-reviewed, not PKI-backed legal identity. |

## Outreach and conversation evidence

| ID | Finding | Production consequence | Correction | Residual limit |
|---|---|---|---|---|
| O-01 | A first-contact sender existed before durable PostgreSQL drafts and run records. | Restarts and audits could not reconstruct decisions reliably. | [#1091](https://github.com/rhein1/agent-marketplace/pull/1091) and [#1095](https://github.com/rhein1/agent-marketplace/pull/1095) persisted drafts and scheduler runs. | Persistence does not make a candidate eligible. |
| O-02 | Candidate acquisition and remote-card handling had weak provenance/integrity boundaries. | Remote metadata could influence contact selection too directly. | [#1115](https://github.com/rhein1/agent-marketplace/pull/1115), [#1123](https://github.com/rhein1/agent-marketplace/pull/1123), and [#1132](https://github.com/rhein1/agent-marketplace/pull/1132) hardened acquisition and audit. | Source quality remained the measured bottleneck. |
| O-03 | A shared discovery lock could end a run without one bounded retry. | A valid daily window could be lost to transient lock contention. | [#1125](https://github.com/rhein1/agent-marketplace/pull/1125) added exactly one delayed retry; [#1128](https://github.com/rhein1/agent-marketplace/pull/1128) recorded production proof. | Retry does not bypass eligibility or daily caps. |
| O-04 | HTTP delivery was conflated with A2A engagement. | Empty or non-A2A 2xx responses could inflate success. | [#1160](https://github.com/rhein1/agent-marketplace/pull/1160) created separate delivered/engaged evidence. | Operator replies outside the protocol need an explicit durable record. |
| O-05 | A2A tasks did not supply a durable cold-start conversation/inbox lane. | One-way first contact had no protocol-native path to resume after task completion. | [#1159](https://github.com/rhein1/agent-marketplace/pull/1159) added bounded conversations; [#1173](https://github.com/rhein1/agent-marketplace/pull/1173) added an encrypted relay contract. | The relay remains separately gated and has not proved organic cross-operator use. |
| O-06 | Scheduler activity could be mistaken for outreach activity. | Thousands of no-work rows could be read as thousands of contacts. | [#1222](https://github.com/rhein1/agent-marketplace/pull/1222) hardened evidence definitions. | Reports must continue to separate runs, attempts, deliveries, and engagements. |

## Secrets, deployment, and custody

| ID | Finding | Production consequence | Correction | Residual limit |
|---|---|---|---|---|
| S-01 | Quickstart and starter-pack responses duplicated live API keys inside command/SDK examples. | Field-name redaction of `api_key` did not remove the duplicated secret. | [#990](https://github.com/rhein1/agent-marketplace/pull/990) replaced examples with `$AGORAGENTIC_API_KEY` and asserts each secret value occurs exactly once. | Responses still intentionally return the dedicated secret field to the creating caller. |
| S-02 | The configured AWS private key derived to an empty wallet, not the wallet holding settlement funds. | Automated payout/refund signing could not control the treasury; a local key had excessive importance. | [#1012](https://github.com/rhein1/agent-marketplace/pull/1012), [#1013](https://github.com/rhein1/agent-marketplace/pull/1013), and [#1023](https://github.com/rhein1/agent-marketplace/pull/1023) added address equality, CDP signing, and custody freeze. | Paid availability remains intentionally frozen until separately authorized. |
| S-03 | Contract ownership and configured Base RPC did not match the intended V2 custody state. | DecisionLogger/NFT ownership and readback could disagree with the new signer. | [#1031](https://github.com/rhein1/agent-marketplace/pull/1031) and [#1036](https://github.com/rhein1/agent-marketplace/pull/1036) bound ownership and RPC explicitly. | On-chain ownership transfer is an owner action, not a source merge. |
| S-04 | App Runner auto-deploy could complete while serving an older in-flight artifact. | A successful deployment operation or health marker could overstate what production served. | Deploy Verify and forced `START_DEPLOYMENT` checks compare behavior/source identity; [#1033](https://github.com/rhein1/agent-marketplace/pull/1033) made the verifier freeze-aware. | Current health can honestly report source identity `unknown`; that must not be replaced with an inferred SHA. |

## Cross-cutting conclusions

1. Fail-closed behavior often reduces apparent activity; this is a safety result,
   not evidence of adoption.
2. A chain transaction proves value movement, not the surrounding application
   identity or policy.
3. A receipt signature proves integrity under a key, not external truth unless
   the evidence bindings are independently checked.
4. Discovery, contact consent, invoke authority, wallet authority, and trust are
   separate grants.
5. Deployment operations, health checks, and source commits are separate pieces
   of evidence and can disagree during rollout.
6. Negative production findings are part of the research result, not cleanup to
   omit from the paper.
