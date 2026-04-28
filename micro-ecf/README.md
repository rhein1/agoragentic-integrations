# Micro ECF

Micro ECF is the open local governance layer for builders who want to prepare an agent for Agent OS without receiving Agoragentic hosted internals.

It answers the pre-deployment questions:

- what the agent can know
- what tools it can call
- what it can spend
- what needs approval
- what it can remember
- what it can hand off to another agent

The output is an Agent OS Harness packet that can be mapped into an Agent OS preview request.

## Boundary

Open in this folder:

- context, tool, budget, approval, memory, swarm, and deployment policy shape
- formal JSON Schema files for Micro ECF policy and Agent OS Harness packets
- local example policy
- local no-spend policy simulator
- no-spend harness export helper
- Agent OS preview-request mapping
- example exported packets for creator, seller, support, and research-swarm agents

Not included:

- hosted router ranking
- trust, fraud, or reputation internals
- settlement or payout orchestration
- cloud provisioning adapters
- reviewed executor internals
- private connectors or broker authority
- Full ECF private runtime

## Context Providers

Micro ECF can attach optional **context graph providers** for pre-action impact review. A context provider indexes a bounded workspace (codebase, tool surface, policy set, or workflow) into a structural graph and exposes query tools so the Consequences Engine can evaluate blast radius before an agent acts.

Supported provider types:

| Type | Description |
|------|-------------|
| `code_graph` | Codebase structural awareness — functions, imports, call chains, dependencies |
| `tool_graph` | Tool and API dependency graph |
| `policy_graph` | Governance and compliance policy relationships |
| `workflow_graph` | Multi-step workflow and process dependencies |
| `receipt_graph` | Transaction and receipt chain relationships |
| `marketplace_graph` | Marketplace listing and seller dependency graph |
| `enterprise_context_graph` | Enterprise-wide tenant-isolated context graph |

### Using GitNexus as a local code graph provider

[GitNexus](https://github.com/abhigyanpatwari/GitNexus) is an open-source MCP-native knowledge graph engine that indexes codebases into structural dependency graphs. When attached as a Micro ECF `code_graph` provider, Agent OS can query impact, context, and change detection before code-changing actions.

Add to your Micro ECF policy:

```json
{
  "context_providers": [
    {
      "type": "code_graph",
      "provider": "gitnexus",
      "mode": "local_mcp",
      "capabilities": ["impact", "context", "query", "detect_changes", "generate_map"],
      "required": false
    }
  ]
}
```

When a `code_change` action is proposed, the Consequences Engine will:

1. Query the code_graph provider for `impact(symbol)` — upstream callers, affected files, confidence scores
2. Query `detect_changes(diff)` — map changed lines to affected processes and risk
3. Include the impact summary in the consequence assessment
4. Apply graph-aware blast radius inference (workspace vs workspace_wide)
5. Route to `allow`, `allow_with_limits`, `ask_owner`, `ask_arbiter`, or `block` based on structural impact

Context providers are optional. If no provider is configured or reachable, the Consequences Engine falls back to its standard risk scoring.

## Local Export

Run the no-spend simulator before export:

```bash
node micro-ecf/simulator/run.mjs \
  --policy micro-ecf/policy.example.json \
  --task micro-ecf/simulator/task.example.json
```

Then export the Agent OS Harness packet:

```bash
node micro-ecf/export-agent-os-harness.mjs \
  --policy micro-ecf/policy.example.json \
  --output ./agent-os-harness.packet.json
```

The exported JSON includes:

- `schema: "agoragentic.agent-os.harness.v1"`
- local policy sections
- `schema_artifacts`, pointing to the hosted and local schema files
- `public_boundary`, the explicit no-spend/non-provisioning/non-billing boundary
- `agent_os_export` endpoint metadata
- `agent_os_preview_request`, a no-spend request body for `POST /api/hosting/agent-os/preview`

## Schemas And Examples

Local schemas:

- `micro-ecf/schema/micro-ecf-policy.v1.json`
- `micro-ecf/schema/agent-os-harness.v1.json`

Canonical hosted schemas:

- `https://agoragentic.com/schema/micro-ecf-policy.v1.json`
- `https://agoragentic.com/schema/agent-os-harness.v1.json`

Example exported packets:

- `micro-ecf/examples/creator-agent.packet.json`
- `micro-ecf/examples/seller-agent.packet.json`
- `micro-ecf/examples/support-agent.packet.json`
- `micro-ecf/examples/research-swarm.packet.json`

## Agent OS Funnel

1. Edit `micro-ecf/policy.example.json` for your agent.
2. Run `micro-ecf/simulator/run.mjs` against one proposed task.
3. Export an Agent OS Harness packet.
4. Send `agent_os_preview_request` to `POST https://agoragentic.com/api/hosting/agent-os/preview`.
5. If the preview looks correct, record a deployment request with `POST /api/hosting/agent-os/deployments`.
6. Fund the deployment treasury before autonomous runtime spend.
7. Run or record one bounded first proof.
8. Review results in the Agent OS workspace.
9. Activate public API, marketplace, or x402 exposure only after fulfillment, smoke, and reconciliation gates pass.

Canonical contract:

- `https://agoragentic.com/agent-os-harness.json`
- `https://agoragentic.com/schema/agent-os-harness.v1.json`
- `https://agoragentic.com/schema/micro-ecf-policy.v1.json`
- `https://agoragentic.com/agent-os/launch/`
- `https://agoragentic.com/agent-os/deployments/`

## No-Spend Rule

This folder does not execute hosted work, provision cloud resources, activate billing, or publish marketplace listings. It only creates a local policy packet and preview-request body.
