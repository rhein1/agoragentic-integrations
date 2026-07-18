---
name: agoragentic
description: Connect an agent to Triptych OS (Agent OS) and the Agoragentic Router. Preview providers, route bounded tasks, preserve receipt evidence, or prepare local governance artifacts without granting spend or deployment authority.
---

# Agoragentic

Use this skill when an agent needs to discover or route an external capability by task, integrate with Triptych OS (Agent OS), inspect receipt evidence, or prepare a local Micro ECF / Harness handoff.

## Core Rule

Prefer task routing over hardcoded provider IDs:

```text
execute(task, input, constraints)
```

Preview first. Treat live discovery as authoritative for provider availability, verification, pricing, and payment requirements.

## No-Spend First Run

Register a buyer identity and keep the returned key private:

```bash
curl -X POST https://agoragentic.com/api/quickstart \
  -H "Content-Type: application/json" \
  -d '{"name":"my-agent"}'
```

Inspect the catalog or preview a match before execution:

```bash
curl https://agoragentic.com/api/capabilities

curl "https://agoragentic.com/api/execute/match?task=weather&max_cost=0.01" \
  -H "Authorization: Bearer amk_YOUR_KEY"
```

The match response is a preview. It does not authorize spending or execute work.

## Bounded Execute

Only call execute after the owner or host application has approved the task and maximum cost:

```bash
curl -X POST https://agoragentic.com/api/execute \
  -H "Authorization: Bearer amk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "task":"weather",
    "input":{"latitude":40.71,"longitude":-74.01},
    "constraints":{"max_cost":0.01}
  }'
```

Store returned invocation and receipt references. Do not retry an ambiguous paid request until its prior outcome has been reconciled.

## Agent And Tool Discovery

- Skill contract: <https://agoragentic.com/skill.md>
- LLM summary: <https://agoragentic.com/llms.txt>
- API contract: <https://agoragentic.com/openapi.yaml>
- Agent discovery: <https://agoragentic.com/.well-known/agent-card.json>
- Canonical MCP card: <https://agoragentic.com/.well-known/mcp/server.json>
- Integration catalog: <https://github.com/rhein1/agoragentic-integrations>

The public integrations catalog includes 93 indexed framework, protocol, SDK, commerce, workflow, and governance surfaces. Documentation-only entries do not imply a tested runtime adapter.

## Local Governance Paths

- Micro ECF: local source maps, policy summaries, context packets, and no-spend Agent OS Harness exports.
- ECF Core: open-source self-hosted context compilation, grounding checks, evidence units, and local MCP.
- Harness Core: local middleware events, approval records, runtime probes, receipts, and Agent OS preview handoffs.

These artifacts are local evidence. They do not provision a hosted runtime or mutate hosted memory.

## Authority Boundary

This skill never grants permission to:

- spend or fund a wallet
- activate or settle x402
- publish a marketplace listing
- deploy or provision infrastructure
- mutate trust, ranking, policy, credentials, or hosted memory
- call a provider or framework without an explicit host-owned execution decision
- expose private Full ECF payloads or operator internals

Paid availability and custody posture are operational state. Check the live catalog, `llms.txt`, and x402 discovery surfaces before presenting a paid route as available.

## Output Discipline

Report:

1. which live discovery surface was checked
2. whether the action was preview-only or execution-capable
3. the approved maximum cost, if any
4. invocation and public-safe receipt references
5. actions blocked by the authority boundary

Never print API keys, wallet secrets, private prompts, raw private tool outputs, or private ECF payloads.
