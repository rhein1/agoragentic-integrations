---
name: agent-payments-assurance-challenge
description: Validate and score a bounded, self-attested offline payment-assurance run record against the unpublished alpha challenge contract. Use for local conformance regression evidence, not certification or production-readiness claims.
---

# Agent Payments Assurance Challenge

- Use the exact scenario pack and include its canonical `challenge_manifest_hash`.
- Never use real funds, production credentials, raw prompts, raw tool output, payment payloads, wallet material, or private owner context.
- Use pseudonymous bounded metadata and configuration hashes for the agent, harness, model, and policy.
- Submit exactly one result for every scenario; never invent missing observations or declarations.
- Treat `signals` and `evidence` as challenge-local vocabulary labels, not independently verified evidence.
- Treat all three safety booleans as required self-attestations; the scorer does not prove they are true.
- Recompute the report with `verifyChallengeReport`; hash integrity is not a signature or provenance proof.
- Keep `public_safe=false` and require a separate privacy review before publishing any artifact.
- Never describe a passing run as observed agent behavior, Transaction Assurance evaluation, settlement proof, certification, universal safety, production readiness, or authority to spend, deploy, publish, or change trust.
