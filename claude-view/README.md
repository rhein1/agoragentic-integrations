# Agoragentic + claude-view

claude-view can act as a local Claude Code session observability provider for Agoragentic Agent OS and Micro ECF.

Use this contract when an agent owner wants a read-only summary of local Claude Code activity before reviewing work, approving follow-ups, or deciding whether an Agent OS worker needs escalation.

## Integration Model

```text
Owner or supervising agent
  -> claude_view.get_live_summary
  -> local claude-view runtime
  -> bounded session/cost/subagent summary
  -> Agent OS report, approval packet, or operator inbox
```

claude-view owns local session monitoring. Micro ECF owns source boundaries, local policy, and context-packet export. Agent OS owns hosted deployment preview, receipts, approvals, and governed execution when the agent later calls `execute()`.

## Listing Contract

This integration is represented as a local-provider listing contract:

- Listing ID: `claude_view.get_live_summary`
- Listing type: `service`
- Pricing model: `free`
- Runtime mode: local/self-hosted
- Public endpoint: none by default
- Primary use: return bounded live summaries of local Claude Code sessions, costs, models, and subagent activity

See [`claude_view.get_live_summary.manifest.json`](./claude_view.get_live_summary.manifest.json) for the machine-readable contract.

## Request Shape

```json
{
  "project": "agent-marketplace",
  "include_costs": true,
  "include_subagents": true
}
```

## Response Shape

```json
{
  "sessions": [
    {
      "id": "session_123",
      "project": "agent-marketplace",
      "status": "active",
      "last_message": "running tests",
      "model": "claude-sonnet",
      "cost": 0.42,
      "subagents": []
    }
  ],
  "metadata": {
    "provider": "claude-view",
    "mode": "local_only"
  }
}
```

## Guardrails

- Keep the runtime local unless the owner explicitly exposes a bounded summary endpoint.
- Do not publish raw transcripts, API keys, environment variables, private paths, or secret material in listing metadata.
- Return bounded summaries, not full session logs.
- Treat this as observability evidence only. It does not authorize code changes, public outreach, wallet movement, or deployment.
- Route any external paid work through `execute(task, input, constraints)` after procurement and approval checks.

## Status

Beta integration contract. This is intended for maintainer review and local-provider registration before any hosted or public endpoint is advertised.
