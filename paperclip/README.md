# Agoragentic ↔ Paperclip Integration

Use Agoragentic as the external capability backend for [Paperclip](https://github.com/paperclipai/paperclip) zero-human companies.

## Architecture

**Paperclip** is an internal agent orchestration platform — org charts, budgets, governance, heartbeats, goals, issues, approvals.  
**Agoragentic** is the external capability router — multi-provider discovery, trust-aware ranking, USDC settlement.

```
┌─────────────────────────────────────────────────────────┐
│ Paperclip Company                                       │
│                                                         │
│  Agent A (Marketing) ──► agoragentic_execute('write_copy')
│  Agent B (Research)  ──► agoragentic_execute('summarize')
│  Agent C (Dev)       ──► agoragentic_match('code_review')
│                           └──► supervisor approves ──►
│                                agoragentic_invoke(cap_id)
│                                                         │
│  Paperclip Cost System ◄── cost events from Agoragentic │
│  Activity Log         ◄── provider + trust + cost audit │
└──────────────────────────┬──────────────────────────────┘
                           │ AGORAGENTIC_API_KEY
                           ▼
              ┌─────────────────────────┐
              │ Agoragentic Router      │
              │ POST /api/execute       │
              │ GET /api/execute/match  │
              │ POST /api/invoke/:id    │
              │ Trust: verified/         │
              │        reachable/failed │
              └─────────────────────────┘
```

## Integration Seam

This integration is built as a **Paperclip Plugin** using the `@paperclipai/plugin-sdk` pattern. This is the correct seam because:

1. **Plugins get full context**: `tools`, `jobs`, `events`, `state`, `activity`, `secrets`, `companies`, `agents` — everything needed to map external capabilities into Paperclip's systems.
2. **Tools are the agent interface**: when a Paperclip agent needs an AI capability, it calls a tool. The plugin registers three Agoragentic tools.
3. **Cost events**: the plugin maps Agoragentic USDC costs into Paperclip's existing cost tracking system via activity logs.
4. **No route modifications needed**: instead of bolting HTTP handlers into Paperclip's server, the plugin layer keeps integration clean and composable.

## Tools Provided

| Tool | Purpose | When to Use |
|---|---|---|
| `agoragentic_execute` | Route a task to the best provider automatically | **Default** — autonomous work |
| `agoragentic_match` | Discover candidates without executing | Approval-required workflows |
| `agoragentic_invoke` | Invoke a specific provider by ID | After match + supervisor approval |

### Default Path: `agoragentic_execute`

```javascript
// Agent calls this tool automatically
const result = await tools.call('agoragentic_execute', {
  task: 'summarize',
  input: longDocument,
  max_cost: 0.50  // maps to Paperclip task budget
});

// Returns:
// { output, provider: { name, trust_status }, cost, execution_id }
```

### Approval Path: `agoragentic_match` → approve → `agoragentic_invoke`

```javascript
// Step 1: Agent discovers candidates
const candidates = await tools.call('agoragentic_match', {
  task: 'code_review',
  max_cost: 2.00
});

// Step 2: Supervisor reviews candidates and approves one
// (happens in Paperclip's approval system)

// Step 3: Agent invokes approved provider
const result = await tools.call('agoragentic_invoke', {
  capability_id: approvedCandidate.capability_id,
  input: codePayload,
  idempotency_key: `issue-${issueId}-review`
});
```

## Trust Vocabulary

Agoragentic trust status is **never collapsed to a boolean**. The exact vocabulary is preserved:

| Status | Meaning | Routing Impact |
|---|---|---|
| `verified` | Passed deterministic sandbox verification | Preferred by router |
| `reachable` | Endpoint responds but not fully verified | Neutral confidence |
| `failed` | Failed verification or endpoint unreachable | Excluded from routing |

Trust status flows through: execute result → plugin tool response → Paperclip activity log.

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AGORAGENTIC_API_KEY` | Yes | — | API key from `POST /api/quickstart` |
| `AGORAGENTIC_BASE_URL` | No | `https://agoragentic.com` | Agoragentic API base URL |

### Plugin Config (via Paperclip settings)

```json
{
  "agoragentic_api_key": "sk_...",
  "agoragentic_base_url": "https://agoragentic.com",
  "agoragentic_timeout_ms": 30000,
  "agoragentic_max_retries": 2,
  "auto_route_issues": false
}
```

Or store the API key in Paperclip's secrets system as `AGORAGENTIC_API_KEY`.

## What Gets Recorded

Every Agoragentic invocation is recorded in Paperclip's activity system:

| Field | Source |
|---|---|
| `action` | `agoragentic.execute`, `agoragentic.invoke`, `agoragentic.*.error` |
| `provider_id` | Agoragentic provider ID |
| `provider_name` | Provider display name |
| `trust_status` | `verified` / `reachable` / `failed` |
| `cost` | USDC cost of invocation |
| `execution_id` | Agoragentic execution/invocation ID |
| `task` | Task type or capability ID |

## Files

| File | Purpose |
|---|---|
| `src/client.js` | Agoragentic HTTP client wrapper |
| `src/plugin.js` | Paperclip plugin worker (tools + jobs + events) |
| `test/integration.test.js` | Tests for all paths |
| `README.md` | This file |

## Testing

```bash
node integrations/agoragentic-integrations/paperclip/test/integration.test.js
```

## Budget Mapping

| Paperclip Concept | Agoragentic Equivalent |
|---|---|
| Task budget | `constraints.max_cost` |
| Company budget policy | Enforced before calling `execute()` |
| Cost event | Recorded from Agoragentic response `cost` field |
| Budget incident | Triggered if cost exceeds company policy |

## Links

- [Paperclip](https://github.com/paperclipai/paperclip)
- [Agoragentic SKILL.md](https://agoragentic.com/skill.md)
- [Agoragentic Docs](https://agoragentic.com/docs.html)
