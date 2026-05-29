# Codex prompt: Robinhood Agent OS end-to-end implementation

You are implementing the Robinhood Agent OS integration for Agoragentic.

## Mandatory safety boundary

Do not place live trades, cancel live orders, fetch live virtual-card details, make purchases, scrape Robinhood, use unofficial Robinhood APIs, or persist private account data. Do not make guaranteed-return claims, broker-dealer claims, bank/card-issuer claims, or Robinhood partnership claims.

V1 is governed long-equity and agentic-card support behind explicit user enablement, policy checks, approvals, receipts, and stop controls. Options trading remains disabled roadmap-only.

## Read first

1. The repository `AGENTS.md`.
2. `integrations.json` and `integrations.schema.json`.
3. `agent-os/README.md`.
4. `robinhood/README.md` in this branch.
5. Robinhood's Agentic Trading and Agentic Credit Card support pages.
6. The safe MCP probe output, if available.

## Build sequence

### Phase 0: public scaffold

Confirm these files exist and are valid JSON/Markdown:

```text
robinhood/README.md
robinhood/mcp.json
robinhood/policy.example.json
robinhood/capability-manifest.json
robinhood/probes/robinhood-mcp-probe-template.json
robinhood/prompts/codex-robinhood-mcp-probe.md
```

Add any missing redacted probe example and validation scripts.

### Phase 1: platform handoff contract

Document exactly how the platform should consume:

- MCP server names;
- endpoint URLs;
- capability IDs;
- policy keys;
- approval-required states;
- redacted receipt fields;
- disabled options roadmap flag.

### Phase 2: Agent OS platform implementation

In `rhein1/agent-marketplace`, implement pure modules before routes:

```text
server/modules/finance-agent-policy.js
server/modules/robinhood-agent-os-connector.js
server/modules/financial-research-provider-registry.js
tests/finance-agent-policy.test.js
tests/robinhood-agent-os-connector.test.js
tests/financial-research-provider-registry.test.js
```

Rules:

- disabled connector blocks all dispatch;
- read-only trading calls require enabled connector;
- `place_equity_order` is blocked without review;
- `place_equity_order` is approval-required after review;
- approved order still must pass symbol and notional limits;
- card-detail fetch requires checkout context and approval or explicit monthly-limit policy;
- research output cannot directly execute trades or purchases;
- receipts redact private finance fields.

### Phase 3: owner/admin routes and UI

Only after pure modules and tests pass, add owner/admin routes for:

- connector status;
- policy read/update;
- no-spend/no-trade readiness proof;
- research job creation and artifact readback;
- redacted receipt readback.

Do not add live execution routes before a separate owner-approved beta plan.

### Phase 4: live-read beta

After owner-authorized MCP connection, allow read-only status and schema checks. Do not enable live order placement or card-detail fetch until a separate approved beta change.

## Acceptance tests

- No private data fixtures.
- No live action in tests.
- Options remains disabled.
- Fincept is external/license-review-required.
- Public copy says research and governed execution, not guaranteed profit.

## Pull request body

Include:

- docs reviewed;
- files changed;
- tests run;
- production authority boundary;
- statement that no live trades, purchases, card-detail fetches, or credential collection occurred;
- remaining work for authenticated MCP probe, route/UI beta, and legal/compliance review.
