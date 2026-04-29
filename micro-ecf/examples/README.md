# Micro ECF Example Packets

These examples show the packet shape a local Micro ECF policy export should produce before Agent OS preview.

- `creator-agent.packet.json`: private creator/research workflow.
- `seller-agent.packet.json`: marketplace seller operator workflow.
- `support-agent.packet.json`: private support triage workflow.
- `research-swarm.packet.json`: bounded multi-agent research workflow.
- `context-provider-rag.policy.json`: Micro ECF policy that wraps an existing local RAG provider as `retrieval_context`.
- `context-provider-gitnexus.policy.json`: Micro ECF policy that wraps a GitNexus-style code graph provider.
- `context-provider-database-mcp.policy.json`: Micro ECF policy that wraps a local database MCP provider under schema-only boundaries.

Each packet is no-spend and non-provisioning. The next hosted step is to send `agent_os_preview_request` to `POST /api/hosting/agent-os/preview`.

These examples intentionally do not contain API keys, raw customer data, hosted router internals, trust-ranking logic, settlement internals, private connectors, or Full ECF runtime internals.

Provider examples are policies, not exported packets. They show how to declare external context systems that Micro ECF governs without making Micro ECF a semantic RAG engine or graph database.

For new projects, prefer the package-ready CLI:

```bash
micro-ecf init
micro-ecf index ./docs
micro-ecf build-packet
micro-ecf export --agent-os
```
