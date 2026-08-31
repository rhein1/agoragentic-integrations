---
name: agoragentic-prime-agent
description: Govern Prime Agent tool calls with bounded policy, principal-authority checks, redacted evidence, and local receipts. Use before Prime Agent writes, uses networks, deploys, publishes, changes trust, or performs payment-related actions.
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

A Prime Agent extension is an application policy layer. Prime Agent's worker and kernel processes are not security sandboxes. Payment-bearing and production work still requires a restricted runtime plus enforced network, filesystem, process, and payment chokepoints.

## Qualification boundary

- Bind compatibility claims to Prime Agent `v0.7.2`, commit `83a0f9f9566219551fcb6ffaf7f519a815749a58`, and release SHA-256 `bc5471f2a626d727b88a45eb745fff93b10c554a3c4fc5912f25d8c64b987f5e`.
- Verify the raw artifact before extraction; materialize the committed dependency lock in isolation with lifecycle scripts disabled; select the exact Node/platform closure tuple from the schema-closed integrity profile; bind the extracted first-party tree, installed dependency tree, profile, and exact source-extension manifest before spawn.
- Run with `PI_OFFLINE=1`, `PRIME_AGENT_TELEMETRY=0`, `--offline`, `--no-session`, `--no-builtin-tools`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes`, and `--no-context-files`, loading only the exact local extension with `-e`.
- Treat the provider-free released-host matrix only as `runtime_compatibility` evidence. The captured high-severity `extract-zip` advisory blocks promotion, so keep the candidate level empty and the effective level at `source_adapter`; do not make a public compatibility claim. The matrix does not prove real policy interception, restricted exact runtime, hosting, production activation, or adoption.
- Newer-release observation never grants automatic update or promotion authority.
- Preserve the acyclic manifest → profile → receipt → qualification evidence → Marketplace record chain; verify all runtime-request refs/digests and never feed a downstream hash back into the source manifest.
- Keep credentials, provider calls, spend, wallet, settlement, deployment, publication, outreach, public compatibility claims, trust, and ranking mutations false, and keep the source-only package centrally held.
