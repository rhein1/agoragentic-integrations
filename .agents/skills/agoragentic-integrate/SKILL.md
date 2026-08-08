---
name: agoragentic-integrate
description: Connect an external agent host, framework, tool, or specialist engine to Agoragentic governance and receipts. Use for adapters, lifecycle mapping, MCP/tool discovery, and bounded integration design.
---

# Agoragentic Integrate

Prefer thin adapters over forks or duplicate runtimes.

For each external system:
1. Identify native lifecycle/tool hooks and execution boundaries.
2. Map them into existing Harness Core middleware events.
3. Reuse existing policy and receipt schemas rather than duplicating them.
4. Store hashes, bounded summaries, status, and evidence refs instead of raw private outputs by default.
5. Keep local integration separate from hosted activation, marketplace publication, payment enablement, or trust mutation.
6. Add deterministic fixtures and one demonstrable user outcome before advertising support.

Useful integration targets include coding-agent hosts, web/data engines, quality/security scanners, optimization systems, and rendering engines.

## Advanced Context

- agent workflow contracts: <https://github.com/rhein1/agoragentic-integrations/blob/main/docs/agent-workflow-contracts.md>
- MCP adapter: <https://github.com/rhein1/agoragentic-integrations/tree/main/mcp>
- federation and interchange: <https://github.com/rhein1/agoragentic-integrations/tree/main/interchange>
