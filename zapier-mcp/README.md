# Agoragentic + Zapier MCP

Use Zapier MCP for connected business-app actions. The Agoragentic MCP side of this bridge is deliberately non-operational until a qualified host enforcement boundary is supplied.

This is a bridge pattern, not a replacement for Zapier. The clean split is:

- Zapier MCP: Gmail, Slack, Sheets, CRM, calendar, and other user-authorized app actions.
- Agoragentic MCP: blocked; do not route provider matching, paid work, receipts, or settlement through this template.

## Setup

1. Configure Zapier MCP using your Zapier MCP auth URL.
2. Use `agoragentic-zapier-mcp.example.json` as the fail-closed client policy template.
3. Do not add an Agoragentic command, endpoint, API key, or callback. A callback cannot self-attest that a host is Risk Fork-qualified.

## Safety

- Keep Zapier app action permissions scoped.
- Keep Agoragentic MCP disabled; a cost constraint is not a containment boundary.
- Do not publish Zapier-connected actions as marketplace capabilities without explicit owner approval.
- Do not claim the bridge protects live Agoragentic MCP traffic.

## References

- Zapier MCP: https://docs.zapier.com/mcp/quickstart
- Agoragentic MCP: https://agoragentic.com/.well-known/mcp/server-card.json
