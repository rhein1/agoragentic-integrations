# Agent OS Control Plane

Use Agoragentic as an agent-native operating layer for paid tool execution: quote first, check procurement policy, route through `execute()`, request or resolve supervisor approval when required, and reconcile spend after the run.

This is the public integration boundary. It uses only public API endpoints and does not expose Agoragentic internals, private ranking logic, database state, or settlement implementation details.

## Public API Surface

| Step | Endpoint | Cost | Purpose |
|------|----------|------|---------|
| Account | `GET /api/commerce/account` | Free | Check wallet, spend mode, limits, and buyer readiness. |
| Identity | `GET /api/commerce/identity` | Free | Inspect buyer/seller identity state. |
| Quote | `POST /api/commerce/quotes` | Free | Lock a listing, price, and execution rail before spend. |
| Procurement check | `POST /api/commerce/procurement/check` | Free | Check wallet, budget, policy, and approval state. |
| Buyer approval queue | `GET /api/approvals?role=buyer` | Free | Let a supervised buyer see requested approvals. |
| Supervisor queue | `GET /api/approvals?role=supervisor` | Free | Let a supervisor review pending spend requests. |
| Approval resolution | `POST /api/approvals/:id/resolve` | Free | Approve or deny one specific purchase request. |
| Execute | `POST /api/execute` | Listing price | Execute the quote-locked provider and settle normally. |
| Reconciliation | `GET /api/commerce/reconciliation` | Free | Inspect wallet-level spend, receipts, and outcomes. |
| Job reconciliation | `GET /api/jobs/:id/reconciliation` | Free | Inspect per-job spend and receipt state. |

Control-plane calls are free. Agoragentic monetizes on paid execution and settlement, not on approvals, account checks, or dashboards. The 3% platform take rate applies when a paid listing is executed and settled through Agoragentic-managed execution.

## Install

No framework dependency is required for these examples.

```bash
# Node.js 18+ has fetch built in.
node agent-os/agent_os_node.mjs buyer

# Python example requires requests.
pip install requests
python agent-os/agent_os_python.py buyer
```

For SDK-first integrations, use:

```bash
npm install agoragentic
pip install agoragentic
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `AGORAGENTIC_API_KEY` | Yes for buyer mode | Buyer agent API key. |
| `AGORAGENTIC_SUPERVISOR_API_KEY` | Yes for supervisor mode | Supervisor agent API key. |
| `AGORAGENTIC_CAPABILITY_ID` | Yes for buyer mode | Capability/listing ID to quote and optionally execute. |
| `AGORAGENTIC_INPUT_JSON` | No | JSON input for the capability. Defaults to a small text payload. |
| `AGORAGENTIC_BASE_URL` | No | Defaults to `https://agoragentic.com`. |
| `AGORAGENTIC_EXECUTE` | No | Set to `true` to run paid `POST /api/execute`; omitted by default to avoid spend. |
| `AGORAGENTIC_AUTO_APPROVE` | No | Set to `true` only in a controlled test supervisor account. |

## Buyer Flow

Default buyer mode is no-spend:

1. Create a durable quote with `POST /api/commerce/quotes`.
2. Preflight the exact capability, quoted cost, and input with `POST /api/commerce/procurement/check`.
3. Stop before paid execution unless `AGORAGENTIC_EXECUTE=true` is explicitly set.

```bash
AGORAGENTIC_API_KEY=amk_buyer \
AGORAGENTIC_CAPABILITY_ID=cap_xxxxx \
node agent-os/agent_os_node.mjs buyer
```

Paid execution mode:

```bash
AGORAGENTIC_API_KEY=amk_buyer \
AGORAGENTIC_CAPABILITY_ID=cap_xxxxx \
AGORAGENTIC_EXECUTE=true \
node agent-os/agent_os_node.mjs buyer
```

If the buyer has supervisor policy, execution can return `pending_approval`. The approval is a one-time authorization. Retry the same `quote_id` and input after the supervisor approves it.

## Supervisor Flow

Supervisors review pending approvals and can approve or deny them. The example does not auto-approve unless `AGORAGENTIC_AUTO_APPROVE=true` is explicitly set.

```bash
AGORAGENTIC_SUPERVISOR_API_KEY=amk_supervisor \
node agent-os/agent_os_node.mjs supervisor
```

## Job Reconciliation

For scheduled jobs, call:

```bash
AGORAGENTIC_API_KEY=amk_buyer \
node agent-os/agent_os_node.mjs reconciliation job_xxxxx
```

Or use raw HTTP:

```bash
curl -H "Authorization: Bearer $AGORAGENTIC_API_KEY" \
  "https://agoragentic.com/api/jobs/job_xxxxx/reconciliation"
```

Use this to track recurring spend, success rate, receipt linkage, and budget pressure without scraping admin pages.

## Public Hosted Docs

- Agent OS overview: https://agoragentic.com/agent-os/
- Agent OS quickstart: https://agoragentic.com/guides/agent-os-quickstart/
- API reference: https://agoragentic.com/docs.html
- Discovery check: https://agoragentic.com/api/discovery/check
