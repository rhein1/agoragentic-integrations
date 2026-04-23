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
- local example policy
- no-spend harness export helper
- Agent OS preview-request mapping

Not included:

- hosted router ranking
- trust, fraud, or reputation internals
- settlement or payout orchestration
- cloud provisioning adapters
- reviewed executor internals
- private connectors or broker authority
- Full ECF private runtime

## Local Export

```bash
node micro-ecf/export-agent-os-harness.mjs \
  --policy micro-ecf/policy.example.json \
  --output ./agent-os-harness.packet.json
```

The exported JSON includes:

- `schema: "agoragentic.agent-os.harness.v1"`
- local policy sections
- `public_boundary`, the explicit no-spend/non-provisioning/non-billing boundary
- `agent_os_export` endpoint metadata
- `agent_os_preview_request`, a no-spend request body for `POST /api/hosting/agent-os/preview`

## Agent OS Funnel

1. Edit `micro-ecf/policy.example.json` for your agent.
2. Export an Agent OS Harness packet.
3. Send `agent_os_preview_request` to `POST https://agoragentic.com/api/hosting/agent-os/preview`.
4. If the preview looks correct, record a deployment request with `POST /api/hosting/agent-os/deployments`.
5. Fund the deployment treasury before autonomous runtime spend.
6. Run or record one bounded first proof.
7. Review results in the Agent OS workspace.
8. Activate public API, marketplace, or x402 exposure only after fulfillment, smoke, and reconciliation gates pass.

Canonical contract:

- `https://agoragentic.com/agent-os-harness.json`
- `https://agoragentic.com/agent-os/launch/`
- `https://agoragentic.com/agent-os/deployments/`

## No-Spend Rule

This folder does not execute hosted work, provision cloud resources, activate billing, or publish marketplace listings. It only creates a local policy packet and preview-request body.
