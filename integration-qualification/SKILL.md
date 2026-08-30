---
name: integration-qualification
description: Qualify an external integration against immutable release evidence and prepare a draft-only human promotion decision without deployment, spend, publication, or outreach.
---

# Integration qualification

Use this workflow when an external framework, host, protocol, or package may deserve an Agoragentic adapter or compatibility record.

1. Identify the canonical upstream project from official metadata.
2. Pin the exact stable tag, source commit, released asset name, size, URL, and independently recomputed SHA-256 digest.
3. Record release drift without changing the pin or executing a newer binary.
4. Classify levels with the prerequisite graph in `src/index.mjs`: policy and runtime both branch from source; exact requires runtime; hosted requires exact; production requires hosted. Never infer a capability from an adjacent branch.
5. Build only the minimum truthful adapter needed for the requested level.
6. Run conformance and adversarial cases at the exact evidence boundary. Verify bytes before extraction or execution.
7. Generate and verify a schema-closed, public-safe evidence packet. Require real RFC 3339 timestamps, credential-free HTTPS URLs, positive safe-integer byte counts, nonblank evidence references, own required object fields, and dense index-only arrays. Reject proxies, accessors, cycles, credentials, local identities, private paths, and provider data before hashing. The JSON Schema is structural; always require the runtime verifier because schema-only acceptance is not evidence. The generic verifier does not dereference or authenticate caller-supplied evidence references, so the integration-specific consumer must cross-bind exact expected references and digests. Inherited values or a new hash never cure malformed evidence.
8. Mark every unresolved failed or unknown observation that blocks promotion in `promotion_blockers`. Preserve supported evidence levels, but withhold candidate levels until blockers are resolved; do not relabel a security or quality blocker as an action-boundary violation.
9. Prepare a draft PR and keep promotion human-owned.
10. Record the result as verified, blocked, regressed, or `update_available` with exact evidence references.

Never treat code, fixtures, docs, generated examples, model output, CI, or a successful hash check as exact-runtime, hosted, or production evidence by itself.

Stop before credentials, paid calls, deployment, publication, outreach, public compatibility claims, wallet or settlement changes, trust changes, or ranking changes unless the owner grants separate exact authority.
