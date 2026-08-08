---
name: agoragentic-prime-agent
description: Govern Prime Agent tool calls with bounded policy, principal-authority checks, redacted evidence, and local receipts. Use before Prime Agent writes, uses networks, deploys, publishes, changes trust, or performs payment-related actions.
---

# Agoragentic for Prime Agent

1. Start with read-only inspection and no-spend proof.
2. Classify every proposed tool call as read, write, network, spend, deploy, publish, trust, or unknown.
3. Allow only actions covered by local policy and existing principal authority.
4. Ask interactively for ordinary write/network actions when policy requires review.
5. Fail closed when review is required but no UI is available.
6. Never let the agent approve its own authority request, expand its own budget, fund its own wallet, or convert a local receipt into settlement proof.
7. Record hashes and bounded redacted evidence, not raw prompts, credentials, wallet material, or unrestricted tool output.
8. Reconcile ambiguous paid outcomes before retrying.

A Prime Agent extension is an application policy layer. Prime Agent's worker and kernel processes are not security sandboxes. Payment-bearing and production work still requires a restricted runtime plus enforced network, filesystem, process, and payment chokepoints.
