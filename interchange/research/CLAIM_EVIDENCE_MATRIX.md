# Claim and Evidence Matrix

Use this table when drafting the paper, abstract, README copy, talks, or press
material. The allowed wording is deliberately narrower than the strongest
internal implementation claim.

| Claim topic | Evidence | Paper-safe wording | Do not claim |
|---|---|---|---|
| Interchange lifecycle | Merged source, production records, recruited external runs | "Agoragentic implemented and production-tested a 12-state governed transaction lifecycle from discovery through reconciliation." | Universal correctness, formal verification, or broad external adoption. |
| Outbound external x402 | Base transaction `0x9b01...7d44`, [#672](https://github.com/rhein1/agent-marketplace/pull/672) | "A platform-controlled canary paid a third-party x402 seller 0.005 USDC on Base." | External buyer demand or a verifiable signed receipt for that historical run. |
| External buyer internal-balance lifecycle | Recruited operator run and signed receipt | "A recruited external agent completed the governed lifecycle using owner-seeded internal balance." | External money, organic use, or revenue. |
| Modern CAIP-2 x402 client | Base transaction `0x705c...6e95`; bound production run | "A recruited external operator used an unmodified modern EVM x402 client to pay 0.01 USDC from its own wallet and complete the governed path." | Organic demand, retained revenue, or support for every x402 client. |
| Base settlement finality | Base JSON-RPC transaction receipt and USDC `Transfer` log | "The cited payment transaction succeeded and the specified USDC amount moved between the indexed wallets in the cited block." | That the chain alone proves agent identity, mandate, result quality, or receipt signature. |
| Signed Interchange receipt | Public verifier contract and recruited run evidence | "The Interchange receipt recomputed and verified under the configured receipt-signing key." | Independent truth of every input absent source/evidence verification. |
| Anchor key control | Schema-validated public evidence and reciprocal operator checks | "Two independent operators completed a TOFU-based Ed25519 key-control challenge for the reviewed relationship." | Legal identity, certification, endorsement, or standing operational federation. |
| Anchor capability exchange | Bounded 24-hour evidence, reproduced hashes, expiry closure | "The operators exchanged public capability metadata within explicit request budgets and automatically closed the feed at expiry." | Task execution, payments, referrals, routing, private-data exchange, or ongoing authority. |
| Federation protocol maturity | One external pilot plus local conformance vectors | "The v0 federation contract is experimentally interoperable for the tested key-control and read-only exchange scope." | Production-ready universal federation. |
| Autonomous outreach | Durable run/receipt audit and fixed observation windows | "The bounded outreach system enforced one first contact per day and later failed closed when candidates lacked consent or protocol compatibility." | A successful acquisition channel or meaningful engagement. |
| Pre-fix delivery | Three contacted domains, no valid engagement | "Three first contacts were sent; none produced a valid A2A engagement." | Three conversations, responses, leads, or partners. |
| Post-fix outreach | Seven intended windows, zero eligible sends | "No live sends were made because candidates failed consent, card, origin, protocol, reachability, or cooldown checks." | Scheduler failure merely from zero sends. |
| Scheduler rows | 1,613 durable rows in the stated audit window | "The audit retained scheduler decisions and no-work runs." | 1,613 outreach attempts or messages. |
| Discovery sync | Live six-hour scheduler, source stats, provenance records | "The Interchange maintains a provenance-only external discovery index with freshness and leader-guard evidence." | Contact, invoke, trust, referral, routing, or payment authority from imported metadata. |
| Official MCP Registry | One accepted 50-record production run at snapshot time | "One bounded Official MCP Registry synchronization succeeded; 24-hour cadence proof was pending at the 2026-08-14T20:00Z snapshot." | Repeat cadence until the second qualifying run is recorded. |
| Global A2A Registry | Reader/source code merged, source config disabled | "A bounded provenance reader exists." | Active ingestion, partnership, consent, or operational projection. |
| Principal authority model | [#1302](https://github.com/rhein1/agent-marketplace/pull/1302)-[#1308](https://github.com/rhein1/agent-marketplace/pull/1308) | "Paid routes now require explicit principal-bound authority for reserved-wallet and authenticated settlement operations." | That source merge itself granted any principal authority. |
| Current paid availability | 2026-08-14 x402 probes returned custody freeze | "Historical paid interoperability is proved, but new paid execution was unavailable under the authoritative custody freeze at the snapshot time." | "x402 is currently live" without a fresh behavior check. |
| Revenue | Recruited test payments and owner canaries | "Real USDC moved during controlled tests." | Organic revenue or retained external revenue. |
| Adoption | Recruited buyer and one independent federation operator | "The system has recruited external interoperability evidence." | Organic adoption, repeat adoption, marketplace liquidity, or product-market fit. |
| Priority/novelty | Internal chronology and public protocol comparisons | "This case study documents one production implementation and its findings." | "World first," "first ever," or priority over other projects without independent literature and date evidence. |

## Mandatory qualifiers

Use these qualifiers whenever the corresponding evidence appears:

- **recruited external buyer** rather than simply **external buyer** when the
  actor was asked to run the test;
- **owner-seeded internal balance** for the internal-rail pilot;
- **own wallet** for the CAIP-2 settlement, paired with **recruited**;
- **test payment** rather than **revenue** unless retention and accounting are
  separately proved;
- **TOFU key-control** rather than **verified identity**;
- **delivered without engagement** for empty/non-A2A 2xx responses;
- **source merged**, **deployed**, **activated**, and **exercised** as separate
  statuses; and
- **snapshot at `<timestamp>`** for live flags, custody, and availability.

## Evidence precedence

When sources disagree, prefer in this order for the narrow fact each can prove:

1. immutable chain receipt/log for value movement and block inclusion;
2. public signed/hash-bound evidence for the exact included fields;
3. bounded live behavior probe for current route behavior;
4. production audit record for private operational events;
5. merged source for implementation state; and
6. documentation or operator narrative for context.

No source proves facts outside its layer. In particular, chain evidence does not
prove application intent, and source code does not prove deployment or use.
