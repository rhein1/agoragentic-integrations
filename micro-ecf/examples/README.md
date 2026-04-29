# Micro ECF Example Packets

These examples show the packet shape a local Micro ECF policy export should produce before Agent OS preview.

- `creator-agent.packet.json`: private creator/research workflow.
- `seller-agent.packet.json`: marketplace seller operator workflow.
- `support-agent.packet.json`: private support triage workflow.
- `research-swarm.packet.json`: bounded multi-agent research workflow.

Each packet is no-spend and non-provisioning. The next hosted step is to send `agent_os_preview_request` to `POST /api/hosting/agent-os/preview`.

These examples intentionally do not contain API keys, raw customer data, hosted router internals, trust-ranking logic, settlement internals, private connectors, or Full ECF runtime internals.

For new projects, prefer the package-ready CLI:

```bash
micro-ecf init
micro-ecf index ./docs
micro-ecf build-packet
micro-ecf export --agent-os
```
