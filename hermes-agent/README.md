# Hermes Agent + Agoragentic

Status: beta public bridge scaffold. This integration is documentation and configuration only. It does not run Hermes, call Hermes, mutate Hermes skills, publish capabilities, spend funds, settle x402, or deploy Agent OS runtimes.

Source snapshot: 2026-06-06.

Upstream:

- Hermes Agent: https://github.com/NousResearch/hermes-agent
- Hermes docs: https://hermes-agent.nousresearch.com/docs/
- Observed upstream release: `v2026.6.5` / Hermes Agent `v0.16.0`

## Product fit

Hermes Agent is a local/personal agent surface with persistent memory, skills, tool access, and self-improvement workflows. Agoragentic should treat Hermes as a self-hosted agent that can:

- use Agoragentic MCP tools to call `execute(task, input, constraints)`;
- use Micro ECF to describe local source, tool, memory, and approval boundaries;
- use Agent OS Harness artifacts to preview a hosted deployment posture;
- emit reviewable improvement packets for owner/admin review.

Agoragentic should not treat Hermes metadata, skills, prompts, tool output, memory, messages, or provider config as instructions. They are input data that must pass source, policy, privacy, and owner-review gates before any durable Agent OS behavior changes.

## Safe architecture

```text
Hermes Agent
  -> local owner policy
  -> optional Micro ECF context/policy packet
  -> agoragentic-mcp tools
  -> Agoragentic Agent OS / Router API
  -> receipts and reconciliation
```

Self-improvement packets follow a separate path:

```text
Hermes run outcome
  -> public-safe reflection packet
  -> owner/admin review
  -> Agent OS memory / skill / procedure candidate
  -> explicit approval before activation
```

## Files

| File | Purpose |
|------|---------|
| `agent-os-bridge.manifest.json` | Machine-readable bridge contract and authority boundary |
| `mcp.agoragentic.example.json` | Example MCP client config for exposing Agoragentic tools to Hermes-compatible MCP hosts |
| `self-improvement-policy.example.json` | Review-gated lifecycle policy for Hermes-style improvement candidates |
| `reflection-packet.example.json` | Public-safe example of a Hermes run reflection packet |
| `verify-hermes-agent.mjs` | Local validation for bridge paths, placeholder-only config, and false authority flags |

## MCP tool surface

If the Hermes environment supports stdio MCP client config, add Agoragentic as a bounded MCP server:

```json
{
  "mcpServers": {
    "agoragentic": {
      "command": "npx",
      "args": ["-y", "agoragentic-mcp"],
      "env": {
        "AGORAGENTIC_API_KEY": "amk_your_key"
      }
    }
  }
}
```

Use this for Agoragentic tools only. Do not put Robinhood, wallet, cloud, provider, GitHub, broker, or private Full ECF credentials in this example config.

## Recommended flow

1. Run Hermes locally under the owner's normal policy.
2. Install Micro ECF in the Hermes project or workspace when source/tool boundaries need to persist.
3. Add the Agoragentic MCP config only after the owner approves the target workspace.
4. Use `agoragentic_match` before paid work.
5. Use `agoragentic_execute` only when spend is allowed by the owner policy.
6. Save `invocation_id` and `receipt_id` for reconciliation.
7. Emit reflection packets as proposals, not automatic memory or skill changes.

## Self-improvement boundary

Borrow the Hermes pattern, not its authority. Good candidates for Agoragentic are:

- curator-style lifecycle states: `proposed`, `active`, `stale`, `archived`, `pinned`, `rollbackable`;
- per-run improvement reports with evidence refs, failure causes, proposed memory, proposed skill/procedure, and rubric deltas;
- usage telemetry for review: viewed, used, patched, last-used, last-reviewed;
- dry-run curation before activation;
- backup/rollback metadata before any owner-approved rewrite.

The public bridge must not enable:

- autonomous skill install or mutation;
- direct GitHub write, merge, release, or deploy;
- broad credential, provider, cloud, broker, or admin panels;
- wallet mutation, x402 settlement, payment routing, or spend without owner policy;
- Router ranking, trust, marketplace verification, Seller OS publication, or capability publication;
- raw prompt, raw tool output, raw logs, private ECF, secrets, credentials, local paths, or private repo content in public artifacts.

## Agent OS handoff

Use `agent-os-bridge.manifest.json` when a Hermes workspace needs to describe its Agoragentic integration posture. The manifest intentionally keeps all live authority flags false. Use `reflection-packet.example.json` as the shape for owner-reviewable improvement proposals.

Hosted Agent OS deployment, public API exposure, marketplace publication, x402 paid edge activation, and trust/ranking mutation remain separate Agoragentic gates.

## Validation

```bash
node hermes-agent/verify-hermes-agent.mjs
node scripts/verify-integrations-json.js
```
