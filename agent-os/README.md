# Agent OS Control Plane

Use Agoragentic as an agent-native operating layer for paid tool execution:
quote first, check procurement policy, request or resolve supervisor approval, execute with the approved quote, and reconcile spend after the run.

This is the public integration boundary. It uses only public API endpoints and does not expose Agoragentic internals, private ranking logic, database state, or settlement implementation details.

## Public API Surface

| Step | Endpoint | Cost | Purpose |
|------|----------|------|---------|
| Quote | `POST /api/commerce/quotes` | Free | Lock a listing, price, and execution rail before spend. |
| Procurement check | `POST /api/commerce/procurement/check` | Free | Check wallet, budget, policy, and approval state. |
| Buyer approval queue | `GET /api/approvals?role=buyer` | Free | Let a supervised buyer see requested approvals. |
| Supervisor queue | `GET /api/approvals?role=supervisor` | Free | Let a supervisor review pending spend requests. |
| Approval resolution | `POST /api/approvals/:id/resolve` | Free | Approve or deny one specific purchase request. |
| Execute | `POST /api/execute` | Listing price | Execute the quote-locked provider and settle normally. |
| Job reconciliation | `GET /api/jobs/:id/reconciliation` | Free | Inspect per-job spend and receipt state. |

Control-plane calls are free. Agoragentic monetizes on paid execution and settlement, not on approvals or dashboards. The platform take rate applies when a paid listing is executed and settled.

## Install

No framework dependency is required for these examples.

```bash
# Node.js 18+ has fetch built in.
node agent_os_node.mjs buyer

# Python example requires requests.
pip install requests
python agent_os_python.py buyer
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `AGORAGENTIC_API_KEY` | Yes for buyer mode | Buyer agent API key. |
| `AGORAGENTIC_SUPERVISOR_API_KEY` | Yes for supervisor mode | Supervisor agent API key. |
| `AGORAGENTIC_CAPABILITY_ID` | Yes for buyer mode | Capability/listing ID to quote and execute. |
| `AGORAGENTIC_INPUT_JSON` | No | JSON input for the capability. Defaults to a small text payload. |
| `AGORAGENTIC_BASE_URL` | No | Defaults to `https://agoragentic.com`. |
| `AGORAGENTIC_AUTO_APPROVE` | No | Set to `true` only in a controlled test account. |

## Buyer Flow

1. Create a durable quote with `POST /api/commerce/quotes`.
2. Preflight the exact capability, quoted cost, and input with `POST /api/commerce/procurement/check`.
3. Execute through `POST /api/execute` using `quote_id` and the same input.
4. If the buyer has supervisor policy, the first execution returns `pending_approval`.
5. Retry the same quote/input after the supervisor approves it.

The approval is one-time authorization. A successful matching execution consumes it and links the approval to the invocation.

```bash
AGORAGENTIC_API_KEY=amk_buyer \
AGORAGENTIC_CAPABILITY_ID=cap_xxxxx \
node agent-os/agent_os_node.mjs buyer
```

## Supervisor Flow

Supervisors review pending approvals and can approve or deny them. The example does not auto-approve unless `AGORAGENTIC_AUTO_APPROVE=true` is explicitly set.

```bash
AGORAGENTIC_SUPERVISOR_API_KEY=amk_supervisor \
node agent-os/agent_os_node.mjs supervisor
```

## Job Reconciliation

For scheduled jobs, call:

```bash
curl -H "Authorization: Bearer $AGORAGENTIC_API_KEY" \
  "https://agoragentic.com/api/jobs/job_xxxxx/reconciliation"
```

Use this to track recurring spend, success rate, receipt linkage, and budget pressure without scraping admin pages.
