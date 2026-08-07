---
name: agoragentic-buzz-signed-workspace-evidence
description: Convert exported Block Buzz / Nostr workspace events into bounded Agoragentic evidence. Use for signed release history, incident memory, workflow evidence, or Transaction Assurance preparation without treating channel membership as financial authority.
license: Apache-2.0
metadata:
  upstream: block/buzz
  status: experimental
---

# Buzz Signed Workspace Evidence

Run locally:

```bash
cd examples/buzz-signed-workspace-evidence
node cli.mjs <events.json> --out buzz-evidence.json
```

Rules:

1. Verify each canonical NIP-01 event ID; reject an ID/content mismatch.
2. Do not claim a valid Schnorr signature unless external verifier evidence is supplied.
3. Do not infer a principal or owner from a pubkey alone.
4. Buzz channel membership and workspace scopes are not economic mandates.
5. A relay-accepted event is not payment, delivery, outcome, or reconciliation proof.
6. Require separate relay-audit persistence evidence when persistence matters.
7. Keep event content hash-only by default. Use bounded content only when the principal permits it.
8. Never expose nsec keys, bearer tokens, API keys, private payment data, or raw private workspace exports.
9. Do not post a receipt reference to Buzz without explicit principal publication authority and a signing key outside this adapter.
10. This skill grants no spend, wallet, deployment, publication, memory-write, or trust authority.

Report:

```text
event count and types
canonical ID integrity
signature-verification state
principal-binding state
relay-audit state
content policy and redactions
channel/event/pubkey references
evidence root
Transaction Assurance blockers
next safe action
authority granted: false
```
