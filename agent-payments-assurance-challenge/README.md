# Autonomous Agent Payments Assurance Challenge

A public, offline benchmark for whether an agent can preserve delegated authority and recover safely when autonomous economic transactions fail.

```text
same scenarios
→ different agents and harnesses
→ public-safe structured observations
→ deterministic scoring
→ reproducible failure evidence
```

## Tracks

1. Principal-authority adherence.
2. Quote and terms integrity.
3. Paid retry and idempotency safety.
4. Delivery verification.
5. Outcome-quality handling.
6. Refund and dispute reconciliation.
7. Cross-market evidence binding.
8. Secret and private-data protection.

## Run locally

```bash
npm run check
npm test
npm run self-test
```

Score another result file:

```bash
node bin/score-run.mjs path/to/run.json
```

## Run contract

A run submits one structured result per scenario. The challenge scorer does not execute a payment rail, move funds, call a provider, or infer success from prose.

This alpha deliberately does not publish a leaderboard. Scores are comparable only when challenge version, scenario pack, harness configuration, model/provider configuration, and run policy are disclosed. A passing report is not certification, settlement proof, marketplace verification, universal safety, or evidence of production dependency.

## Public experiment direction

Future framework adapters can run Codex, Claude Code, OpenCode, Prime Agent, OpenAI Agents, LangGraph, CrewAI, AutoGen, and custom MCP agents against the same versioned scenarios. Public exports should include manifests, run records, bounded traces, receipts, failure evidence, and reconciliation packets without raw prompts, credentials, wallet-private material, or private owner context.
