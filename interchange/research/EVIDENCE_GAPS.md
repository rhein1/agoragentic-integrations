# Evidence Gaps Before Publication

The current package is sufficient to draft the paper and reproduce the public
Anchor and chain evidence. It is not yet a complete archival deposit for every
production claim. Resolve or explicitly disclose the gaps below before final
publication.

## Priority 1: public-safe pilot receipts

Create redacted, immutable exports for:

1. the recruited external agent's owner-seeded internal-balance lifecycle; and
2. the recruited external agent's own-wallet CAIP-2 lifecycle.

Each export should include the exact Interchange receipt id, transaction-plan
reference, state transitions, evidence-reference hashes, signature verification
result, amount/currency/network, settlement transaction hash where applicable,
and explicit exclusion flags for raw payloads, credentials, and wallet-private
data.

Do not publish API keys, signing keys, private wallet material, raw request or
result payloads, internal database identifiers that are not already public, or
operator correspondence beyond separately approved excerpts.

Until those exports exist, the chain transfer is independently reproducible but
the application lifecycle and receipt result remain a public-safe operator
record rather than a fully downloadable third-party-verifiable artifact.

## Priority 2: fixed outreach audit export

Publish one sanitized, immutable machine export for the exact observation
windows. It should contain:

- fixed start/end cursors;
- scheduler-run ids and outcome classes;
- live attempt, delivery, and valid-engagement counts;
- contacted domains for the three pre-fix sends;
- post-fix blocker counts;
- deduplication and daily-cap results;
- zero-authority flags; and
- a source/version fingerprint for the audit code.

The current public issue summary supports the paper narrative, but a machine
export would let reviewers independently verify that 1,613 scheduler rows were
not 1,613 messages.

## Priority 3: deployment evidence packet

For key production milestones, preserve the App Runner operation id, served
source identity or fingerprint, behavior probes, and verification timestamp in
one public-safe packet. Prioritize:

- external x402 rail;
- authenticated-buyer binding;
- CAIP-2 Arbiter wiring;
- federation identity isolation;
- Anchor pull relay;
- custody freeze and CDP signer cutover;
- principal authority enforcement; and
- active discovery sources.

Do not infer a served commit from a successful deployment operation. Record
`unknown` where the source-fingerprint model cannot establish an exact SHA.

## Priority 4: cadence and source-quality closeout

Append the second qualifying Official MCP Registry run only after it is at least
24 hours later than the first accepted run and has a distinct run id. Include
fetched/imported/rejected counts and verify the source remained bounded to 50
records with a one-day minimum interval.

If the proof fails, retain the failed attempt and do not relabel the source
`cadence_proven`.

## Priority 5: refund and revenue accounting

If the paper discusses refunds or economics, publish a separate accounting
table that distinguishes:

- owner-funded canary spend;
- owner-seeded internal balance;
- recruited buyer own-wallet test spend;
- refunds and reclaimed seed;
- platform fees or seller payouts; and
- retained external revenue.

Every on-chain amount should have a transaction hash and every internal-ledger
amount should have a redacted durable ledger reference. Without this table, use
only the narrower claim: **real USDC moved during controlled tests; the record
does not establish retained external revenue.**

## Priority 6: external operator consent and attribution

Before naming individuals or quoting correspondence:

- obtain explicit publication consent;
- agree on product/operator naming;
- give the counterparty the exact excerpt and evidence fields to review;
- preserve the distinction between cryptographic key control and legal identity;
  and
- avoid implying partnership, endorsement, certification, or commercial
  federation.

The current Anchor evidence supports naming the product/operator relationship at
the already approved public-safe level. It does not automatically authorize
publication of private emails or personal details.

## Priority 7: literature and priority review

Perform a dated literature/source review of A2A, x402, agent registries,
store-and-forward agent messaging, capability-based authority, payment-channel
identity, and machine-readable consent. Use primary specifications and original
papers.

Do not make a "world first" or priority claim from this internal chronology.
Novelty should be framed as the combination studied and the production findings,
unless independent evidence establishes a narrower priority statement.

## Publication freeze

Before submission, create one final timestamped runtime snapshot and freeze the
paper's machine evidence version. Later production changes should enter a new
ledger version, not rewrite the evidence used by the submitted paper.
