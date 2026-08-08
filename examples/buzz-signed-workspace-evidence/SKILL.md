---
name: agoragentic-buzz-signed-workspace-evidence
description: Convert exported Block Buzz / Nostr workspace events into bounded Agoragentic evidence. Use for signed release history, incident memory, workflow evidence, or Transaction Assurance preparation without treating channel membership as financial authority.
license: Apache-2.0
metadata:
  upstream: block/buzz@f029deafae6ad3b63e13c29104f3be76122cb1df
  upstream_provenance: upstream-provenance.json
  nip01: nostr-protocol/nips@c53877571f96eb423661fc23c620d629d37b8f19
  status: experimental
---

# Buzz Signed Workspace Evidence

Run locally:

```bash
cd examples/buzz-signed-workspace-evidence
node cli.mjs <events.json> --out buzz-evidence.json
```

Rules:

1. Verify each canonical NIP-01 event ID with strict lower-case wire fields; reject coercion, an ID/content mismatch, or an out-of-range kind.
2. Accept signature, principal, and persistence claims only as typed external attestation references bound to the exact event ID, pubkey, and signature hash.
3. Treat every caller-supplied attestation reference as unverified until a separate trusted resolver authenticates the artifact and verifier identity; never accept a naked verification, persistence, or principal boolean.
4. Do not infer a principal or owner from a pubkey alone.
5. Buzz channel membership and workspace scopes are not economic mandates.
6. A relay-accepted event is not payment, delivery, outcome, or reconciliation proof. Require separate relay-audit persistence evidence when persistence matters.
7. Keep event content and source metadata hash-only by default. Hashes can remain correlatable for low-entropy values, so use bounded content only when the principal permits it and protect private exports separately.
8. Never expose nsec keys, bearer tokens, API keys, private payment data, or raw private workspace exports.
9. Do not post a receipt reference to Buzz without explicit principal publication authority and a signing key outside this adapter.
10. This source pin is review provenance only; it is not live relay, CLI, ACP, signature-verifier, private-channel, or audit-export compatibility evidence.
11. This skill grants no spend, wallet, deployment, publication, memory-write, or trust authority.

Report:

```text
event count and types
exact upstream and NIP-01 source pin
canonical ID integrity
event-bound but unverified signature-attestation-reference state
event-bound but unverified principal-attestation-reference state
event-bound but unverified relay-audit-reference state
content policy and redactions
hash-only source references
evidence root
Transaction Assurance blockers
next safe action
authority granted: false
```
