# Codex prompt: Robinhood MCP schema probe

Goal: inspect Robinhood's official MCP servers safely and produce a redacted schema report for Agent OS integration.

## Official endpoints

```text
Trading MCP: https://agent.robinhood.com/mcp/trading
Banking MCP: https://banking-agent.robinhood.com/mcp/banking
```

## Non-negotiable boundary

This is a schema probe only.

Do not place orders. Do not cancel orders. Do not fetch live virtual-card details. Do not make purchases. Do not collect or commit credentials. Do not save private account values, raw balances, account numbers, positions, order identifiers, card details, browser authorization redirects, or private user data.

If authorization is required, record only the safe status: authorization required, server method attempted, and non-secret error class.

## Setup

For Codex CLI, add the trading MCP server with:

```bash
codex mcp add robinhood-trading --url https://agent.robinhood.com/mcp/trading
```

Then add the banking server using the same remote MCP pattern:

```bash
codex mcp add robinhood-banking --url https://banking-agent.robinhood.com/mcp/banking
```

## Probe steps

1. Read Robinhood's current Agentic Trading and Agentic Credit Card support docs.
2. Attempt MCP initialize for both servers.
3. Attempt list-tools, list-resources, and list-prompts where the server permits it.
4. If unauthenticated access is blocked, stop before any user-private authorization step unless the owner completes authorization locally.
5. If authorized by the owner, list schemas only. Do not call action tools.
6. Save only public-safe schema metadata using `probes/robinhood-mcp-probe-template.json`.

## Expected report fields

- server name
- endpoint URL
- transport behavior
- whether authorization is required
- initialize status
- tool names and redacted JSON schema shapes
- resource list status
- prompt list status
- unsupported or blocked methods
- no-private-material assertion

## Expected trading tool families

The docs currently point to long-equity agentic trading. Verify whether schemas expose the following families:

- account and portfolio reads
- equity positions
- equity quote lookup
- equity tradability checks
- order history
- order review
- order placement
- order cancellation
- search

## Expected banking tool families

Verify whether schemas expose the following families:

- agentic virtual-card policy or settings read
- virtual-card transaction history read
- virtual-card detail fetch for checkout

## Output

Commit a redacted report to:

```text
robinhood/probes/robinhood-mcp-probe-redacted.example.json
```

The report must say whether any live action occurred. For this probe, the correct answer should be no.
