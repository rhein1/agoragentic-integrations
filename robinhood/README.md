# Robinhood Agent OS Integration

Status: public scaffold and implementation plan. This directory does not execute trades, fetch virtual-card data, store private auth material, or claim a Robinhood partnership.

Source snapshot: 2026-05-28.

## Official MCP servers

Robinhood's public agent support docs point MCP clients at these remote servers:

- Trading MCP: `https://agent.robinhood.com/mcp/trading`
- Banking MCP: `https://banking-agent.robinhood.com/mcp/banking`

Use the official MCP servers only. Do not scrape Robinhood or build against unofficial brokerage APIs.

## Product fit

Agoragentic should treat Robinhood as a high-risk, user-owned external finance capability behind Triptych OS (Agent OS) policy controls:

```text
user intent
  -> Agent OS intent contract
  -> connector policy guard
  -> approval queue when required
  -> MCP client
  -> Robinhood MCP server
  -> redacted Agent OS receipt
```

Robinhood remains the system of record for the brokerage account, agentic trading account, card setup, and transaction/order history. Agoragentic supplies governance, budget policy, approvals, receipts, reconciliation, and research orchestration.

## Trading V1 boundary

Robinhood's current public support copy describes agentic trading for long equities through a dedicated Robinhood Agentic account. Agent OS should begin with the following default rules:

- connector disabled until a user connects it;
- read-only tools allowed only after connector enablement;
- `review_equity_order` required before `place_equity_order`;
- manual approval required for live order placement by default;
- per-order and daily notional caps enforced before dispatch;
- margin, short selling, options, crypto, futures, event contracts, and unsupported instruments blocked in V1;
- options trading kept as a disabled roadmap stub only.

Expected public tool families from Robinhood docs:

- account and portfolio reads;
- positions and order history;
- equity quotes;
- equity tradability checks;
- equity order review;
- equity order placement;
- equity order cancellation;
- search.

## Banking/Card V1 boundary

Robinhood's Banking MCP is for the Agentic Credit Card path. Agent OS should begin with these default rules:

- connector disabled until a user connects it;
- checkout context required before fetching virtual-card details;
- merchant domain and amount required before approval;
- manual approval required by default;
- monthly-limit mode allowed only when explicitly configured;
- card details used ephemerally only;
- receipts store masked summaries and safe pointers only.

## Independent research lane

Research should be separate from execution. Fincept and other finance-analysis providers can generate cited artifacts, risk summaries, bull/bear cases, strategy candidates, and receipts. Candidate actions must pass through the Robinhood review and approval gates before any live order.

## Files

- `mcp.json` - official remote MCP endpoint configuration.
- `policy.example.json` - disabled-by-default policy example.
- `capability-manifest.json` - Agent OS capability registration contract.
- `probes/robinhood-mcp-probe-template.json` - safe probe output contract.
- `probes/robinhood-mcp-probe-redacted.example.json` - public-safe auth-required probe example with no private account material.
- `prompts/codex-robinhood-mcp-probe.md` - Codex prompt for safe MCP schema discovery.
- `prompts/codex-robinhood-agent-os-e2e.md` - Codex prompt for the end-to-end implementation.

## Production acceptance criteria

- Safe MCP schema probe completed and redacted.
- No live trade, card-detail fetch, or purchase in tests.
- Policy module proves disabled, blocked, approval-required, and allowed states.
- Disable/disconnect blocks new dispatch immediately.
- Redacted receipts generated for every attempted finance action.
- Public copy avoids guaranteed-return and partnership claims.
