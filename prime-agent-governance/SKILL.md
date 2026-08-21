---
name: agoragentic-prime-agent
description: Govern Prime Agent tool calls and prepare or validate its Agent OS runtime contract with bounded policy, principal-authority checks, redacted evidence, and local receipts. Use before Prime Agent writes, uses networks, deploys, publishes, changes trust, performs payment-related actions, or is proposed for an Agent OS runtime lane.
---

# Agoragentic for Prime Agent

1. Start with read-only inspection and no-spend proof.
2. Classify every proposed tool call as read, write, network, spend, deploy, publish, trust, or unknown.
3. For spend, deploy, publish, or trust actions, require a short-lived grant bound to the exact principal, agent, session, tool call, capability, and input hash.
4. Ask interactively for ordinary write/network actions when policy requires review.
5. Fail closed when review is required but no UI is available.
6. Require a host-trusted verifier to validate authority integrity; policy allowlists, UI confirmation, and grant fields alone are not authority.
7. Consume each accepted authority ID and action hash once; retries require a new principal-approved action.
8. Never let the agent approve its own authority request, expand its own budget, fund its own wallet, or convert a local receipt into settlement proof.
9. Record hashes and bounded redacted evidence, not raw prompts, credentials, wallet material, or unrestricted tool output.
10. Reconcile ambiguous paid outcomes before retrying.
11. Build Agent OS requests only through `buildPrimeAgentRuntimeRequest()` from `@agoragentic/prime-agent/runtime-contract`; use opaque policy, image, credential-profile, MCP-profile, and authority refs.
12. Validate every returned plan and evidence object with `validatePrimeAgentRuntimePlan()` and `validatePrimeAgentRuntimeEvidence()` before treating it as a compatible contract.
13. Treat `contract_compatible` as a schema and hash result only. Never describe it as proof that Prime Agent ran, was sandboxed, authenticated, or production-verified.

A Prime Agent extension is an application policy layer. Prime Agent's worker and kernel processes are not security sandboxes. Payment-bearing and production work still requires a restricted runtime plus enforced network, filesystem, process, credential, payment, stop/revoke, recovery, and reconciliation chokepoints.
