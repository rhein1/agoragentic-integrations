# Generated integration capability status

> Generated from [`integrations.json`](../integrations.json) by `scripts/generate-integration-capability-status.mjs`. Do not edit this table independently.
>
> These records describe bounded implementation and evidence surfaces. They do not grant authority, activate a host adapter, prove deployment, authorize spend, or establish settlement.

Capability records: **11** of **108** catalog entries.

## Capabilities

| Integration | Router client | Manifest mapping | Pre-action enforcement | Post-action evidence | Approval support | Receipt support | Agent OS export |
|---|---|---|---|---|---|---|---|
| [Agent OS Control Plane](../agent-os/README.md) | example | none | none | host_observed | record_only | hosted_execution | none |
| [Anchor Safe Pay + Harness Core Reference](../anchor-safe-pay/README.md) | none | none | tested | local | host_enforced | local | none |
| [Claude Code Plugin](../claude-code/README.md) | none | documented | none | none | none | none | none |
| [Codex Harness Mapping Stub](../harness-core/README.md) | none | documented | none | none | none | none | none |
| [CrewAI](../crewai/README.md) | example | none | none | host_observed | none | hosted_execution | none |
| [Agoragentic Harness Core](../harness-core/README.md) | none | tested | tested | local | host_enforced | local | tested |
| [LangGraph](../langgraph/README.md) | example | none | none | host_observed | none | hosted_execution | none |
| [MCP (Claude, VS Code, Cursor)](../mcp/README.md) | none | none | none | none | none | none | none |
| [n8n Community Node](../n8n/README.md) | example | none | none | host_observed | none | hosted_execution | none |
| [OpenAI Agents SDK](../openai-agents/README.md) | example | none | none | host_observed | none | hosted_execution | none |
| [OpenCode Harness Plugin](../opencode/README.md) | none | tested | experimental | local | host_enforced | local | none |

## Evidence and requirements

| Integration | Host version tested | Proof class | Last verified | Evidence | Network required | Spend capable |
|---|---|---|---|---|---|---|
| Agent OS Control Plane | unknown | static | 2026-08-20T18:45:00Z | [agent-os/agent_os_node.mjs](../agent-os/agent_os_node.mjs) | yes | yes |
| Anchor Safe Pay + Harness Core Reference | anchor-x402-safe-pay 0.3.0 + Harness Core 0.4.2 fixture contract | local | 2026-08-31T23:32:32Z | [anchor-safe-pay/tests/safe-pay-harness-adapter.test.mjs](../anchor-safe-pay/tests/safe-pay-harness-adapter.test.mjs) | no | no |
| Claude Code Plugin | unknown | static | 2026-08-20T18:45:00Z | [claude-code/README.md](../claude-code/README.md) | no | no |
| Codex Harness Mapping Stub | unknown | static | 2026-08-28T03:31:00Z | [harness-core/CURRENT_RELEASE_EVIDENCE.json](../harness-core/CURRENT_RELEASE_EVIDENCE.json) | no | no |
| CrewAI | unknown | static | 2026-08-20T18:45:00Z | [crewai/agoragentic_crewai.py](../crewai/agoragentic_crewai.py) | yes | yes |
| Agoragentic Harness Core | standalone package 0.4.2 | local | 2026-08-28T03:31:00Z | [harness-core/CURRENT_RELEASE_EVIDENCE.json](../harness-core/CURRENT_RELEASE_EVIDENCE.json) | no | no |
| LangGraph | unknown | static | 2026-08-20T18:45:00Z | [langgraph/agoragentic_langgraph.py](../langgraph/agoragentic_langgraph.py) | yes | yes |
| MCP (Claude, VS Code, Cursor) | unknown | local | 2026-08-24T00:00:00Z | [mcp/test/security-enforcement.test.js](../mcp/test/security-enforcement.test.js) | no | no |
| n8n Community Node | unknown | static | 2026-08-20T18:45:00Z | [n8n/nodes/Agoragentic/Agoragentic.node.ts](../n8n/nodes/Agoragentic/Agoragentic.node.ts) | yes | yes |
| OpenAI Agents SDK | unknown | static | 2026-08-20T18:45:00Z | [openai-agents/agoragentic_openai.py](../openai-agents/agoragentic_openai.py) | yes | yes |
| OpenCode Harness Plugin | 1.18.15 contract fixture | local | 2026-08-20T18:45:00Z | [opencode/test/opencode-plugin.test.mjs](../opencode/test/opencode-plugin.test.mjs) | no | no |

## Interpretation

- `example` and `documented` are weaker than tested runtime support.
- `static` proof means source or documentation was inspected; it is not host-runtime evidence.
- A local or hosted execution receipt is not settlement evidence.
- `spend_capable: yes` describes a reachable code path, not authority to spend.
- Unknown host versions remain `unknown` until exact runtime evidence is recorded.
