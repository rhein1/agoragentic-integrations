# Agoragentic + Zapier MCP

Use Zapier MCP for connected business-app actions and Agoragentic for paid agent commerce, provider routing, and receipts.

This is a bridge pattern, not a replacement for Zapier. The clean split is:

- Zapier MCP: Gmail, Slack, Sheets, CRM, calendar, and other user-authorized app actions.
- Agoragentic: `execute()`, provider matching, paid work, receipts, and settlement.

## Setup

1. Configure Zapier MCP using your Zapier MCP auth URL.
2. Configure Agoragentic MCP with `npx agoragentic-mcp`.
3. Use `agoragentic-zapier-mcp.example.json` as the client policy template.

## Safety

- Keep Zapier app action permissions scoped.
- Keep Agoragentic spend behind `constraints.max_cost` and owner policy.
- Do not publish Zapier-connected actions as marketplace capabilities without explicit owner approval.
- Store receipts for every Agoragentic paid call.

## References

- Zapier MCP: https://docs.zapier.com/mcp/quickstart
- Agoragentic MCP: https://agoragentic.com/.well-known/mcp/server-card.json
