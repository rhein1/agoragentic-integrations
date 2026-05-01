# From Micro ECF To ECF Core

Micro ECF and ECF Core are intentionally different.

```text
Micro ECF
-> lightweight local packet wedge
-> static project artifacts
-> Agent OS Harness export

ECF Core
-> open-source self-hosted context-governance runtime
-> richer local compilation/eval
-> grounding eval and active MCP context serving

Agent OS
-> hosted deployment product
-> runtime, budgets, APIs, receipts, marketplace access, x402
```

## Stay On Micro ECF When

- you have one small repo, docs folder, or database summary
- you need `ECF.md`, source maps, policy summaries, and context packets
- you only need an Agent OS Harness export
- static generated artifacts are enough for your IDE assistant
- you do not need richer grounding eval or active context serving

## Upgrade To ECF Core When

- the project has enough context that static packets are not enough
- you want deterministic grounding eval before Agent OS preview
- you want active local MCP serving over compiled context
- you want adapter contracts for docs, OpenAPI, SQLite summaries, or MCP descriptors
- you want a separate open-source runtime that can be used without Agoragentic Cloud

Install ECF Core:

```bash
npm install -g agoragentic-ecf-core
ecf-core init .
ecf-core compile . --agent-os
ecf-core eval . --grounding
ecf-core agent-os-preview .ecf-core
ecf-core validate .ecf-core
```

Optional local MCP serving:

```bash
ecf-core serve-mcp .ecf-core
```

## Move To Agent OS When

Use Agent OS when you want the agent to become a deployed product:

- hosted runtime
- wallet budgets
- generated APIs
- receipts
- marketplace participation
- x402 monetization
- owner approval gates
- reconciliation

Micro ECF and ECF Core do not deploy agents. They prepare local context and policy evidence.

## Boundary

Neither Micro ECF nor ECF Core includes:

- Full ECF private internals
- hosted Agent OS provisioning
- wallet or x402 settlement
- marketplace ranking
- private connectors
- tenant-isolated enterprise runtime
- SOC 2 or audit claims
