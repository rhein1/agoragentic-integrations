# Agoragentic GitHub Copilot Instructions

This GitHub Copilot surface uses Agoragentic Skill Pack v2. For an Agoragentic request, load or read only the smallest matching skill before acting:

- `agoragentic`: Route an Agoragentic task to the smallest applicable skill. Use when the request involves Agoragentic execution, governance, transaction assurance, proof/receipts, deployment, selling, or integration and the correct branch is not yet known.
- `agoragentic-execute`: Preview and execute a bounded Agoragentic capability after explicit owner or host approval. Use for task routing, capability matching, execution constraints, and invocation/receipt capture.
- `agoragentic-govern`: Apply Agoragentic local governance before an agent performs side effects. Use for policy checks, approval packets, authority boundaries, and no-spend Harness or ECF preparation.
- `agoragentic-prove`: Produce or inspect Agoragentic local proof and receipt evidence for an agent run. Use for evidence refs, hashes, run status, policy decisions, approval linkage, and reconciliation.
- `agoragentic-assure`: Prepare and evaluate an autonomous agent transaction without self-granting authority or moving money. Use for bounded authority requests, pre-execution checks, payment and delivery evidence, safe retry decisions, outcome verification, and reconciliation. Contract pin: `@agoragentic/transaction-assurance` `0.2.0-alpha.0`; source `transaction-assurance`; schemas `transaction-assurance/schema/normalized-authority.v1.json`, `transaction-assurance/schema/transaction-assurance-evaluation.v1.json`; network `none`; authority granted `false`.
- `agoragentic-deploy`: Prepare a bounded Agoragentic deployment handoff or preview. Use for Agent OS export, deployment-readiness evidence, runtime probes, and owner-approved transition from local proof to hosted operation.
- `agoragentic-sell`: Prepare an Agoragentic capability for commercial listing or paid routing. Use for listing readiness, pricing/payment metadata checks, seller evidence, and marketplace handoff without publishing or spending automatically.
- `agoragentic-integrate`: Connect an external agent host, framework, tool, or specialist engine to Agoragentic governance and receipts. Use for adapters, lifecycle mapping, MCP/tool discovery, and bounded integration design.

Start with `agoragentic` when the route is unclear. Preview first for any action that may spend, publish, deploy, message, mutate trust, store credentials, or change hosted state. Missing policy, identity, cost, approval, or evidence means blocked. These instructions grant no authority by themselves.
