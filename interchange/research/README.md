# Interchange Research Record

This directory is the public, paper-facing record for the Agent Commerce
Interchange work performed from June through August 2026, with May 2026 treated
only as x402 prehistory where relevant. It complements the implementation
contract in [`../SPEC.md`](../SPEC.md); it does not replace it.

The record is designed to make three kinds of statements independently
checkable:

1. what was implemented and merged;
2. what was deployed or exercised in production; and
3. what external behavior, adoption, or economic activity was actually
   observed.

## Research package

| Artifact | Purpose |
|---|---|
| [`PAPER_OUTLINE.md`](./PAPER_OUTLINE.md) | Suggested paper structure, research questions, method, and limitations. |
| [`CHRONOLOGY.md`](./CHRONOLOGY.md) | Source-linked implementation and production chronology. |
| [`A2A_FEDERATION_CASE_STUDY.md`](./A2A_FEDERATION_CASE_STUDY.md) | Anchor key-control/capability-exchange pilot and autonomous outreach study. |
| [`X402_PRODUCTION_CASE_STUDY.md`](./X402_PRODUCTION_CASE_STUDY.md) | Outbound x402, governed buyer lifecycle, CAIP-2 interoperability, and custody findings. |
| [`PRODUCTION_FINDINGS.md`](./PRODUCTION_FINDINGS.md) | Incident and design-gap ledger with fixes and residual limits. |
| [`CLAIM_EVIDENCE_MATRIX.md`](./CLAIM_EVIDENCE_MATRIX.md) | Paper-safe wording, evidence tier, and wording that the evidence does not support. |
| [`EVIDENCE_GAPS.md`](./EVIDENCE_GAPS.md) | Missing public artifacts and publication-closeout work that must not be papered over. |
| [`REFERENCES.md`](./REFERENCES.md) | Primary protocol specifications and public ecosystem discussions, kept separate from production evidence. |
| [`../evidence/interchange-production-research-ledger.v1.json`](../evidence/interchange-production-research-ledger.v1.json) | Machine-readable summary of experiments, runtime snapshots, findings, and source-change groups. |
| [`../schemas/interchange-production-research-ledger.schema.json`](../schemas/interchange-production-research-ledger.schema.json) | Validation schema for the machine record. |

## Evidence vocabulary

The paper should use these terms literally:

| Level | Meaning |
|---|---|
| `source_merged` | Code or documentation entered the default branch. No runtime claim follows. |
| `deployed` | The relevant artifact was served by production and checked by behavior. This does not mean a gated feature was enabled. |
| `activated` | A production gate was enabled for the stated scope and time. |
| `first_party_exercised` | An Agoragentic-controlled actor exercised the path. Useful engineering proof, not external adoption. |
| `recruited_external_exercised` | A separately operated actor completed the path after direct recruitment. External interoperability is proved; organic demand is not. |
| `independent_external_exercised` | A separately operated system completed the stated experiment and retained its own evidence. This still does not imply repeat use or demand. |
| `organic_adoption` | An external actor used the system without being recruited for the test. No Interchange result in this record reaches this level. |
| `repeat_adoption` | The same external actor returned for another useful transaction outside a test script. Not proved here. |
| `revenue` | External money retained as revenue rather than test funds later refunded. Not proved by the recruited pilots. |

## Method

This is an engineering case study and evidence ledger, not a controlled trial.
It combines:

- merged pull requests and issue history;
- public machine-readable pilot evidence;
- immutable Base L2 transaction receipts and ERC-20 logs;
- bounded production behavior probes;
- operator-to-operator evidence exchanged during the Anchor pilot; and
- negative production evidence from the autonomous outreach observation.

Every runtime observation has a timestamp. Every source-only event is labeled as
such. External-pilot claims identify whether the counterparty was recruited and
whether money was owner-seeded, externally funded, retained, or refunded.

Run the repository-owned structural verifier:

```bash
node scripts/verify-interchange-research.mjs
```

The verifier checks evidence IDs, source-PR uniqueness, authority flags, the two
reviewed Base transaction/amount bindings, and public discovery pointers. JSON
Schema validation remains the authoritative shape check.

## Reproducibility boundary

Public readers can reproduce the linked Git history, the Anchor evidence hashes,
the Base transaction receipt, schemas, canonical signing vectors, and current
public route behavior. They cannot independently reproduce private production
database rows, secret-manager state, private operator correspondence, or the
legal identity behind a TOFU-pinned key. Where those sources informed the
record, the claim is narrowed to the public-safe result and the limitation is
stated.

## Non-claims

This record does **not** claim:

- a global first for x402, A2A plus x402, or agent federation;
- that registry inclusion grants contact, invoke, trust, or payment authority;
- that a TOFU key-control proof establishes legal identity;
- that HTTP delivery is engagement;
- that recruited testing is organic demand;
- that test payments later refunded are revenue; or
- that a currently frozen paid edge is presently available merely because its
  code and historical settlement evidence exist.
