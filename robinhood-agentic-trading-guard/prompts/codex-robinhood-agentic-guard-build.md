# Build Prompt: Robinhood Agentic Trading Guard

Build a public-safe Agoragentic / Triptych OS (Agent OS) integration for Robinhood's official Agentic Trading / MCP flow.

## Objective

Create a governance guard that evaluates proposed Robinhood MCP actions, returns a deterministic policy decision, and emits receipt-shaped evidence.

## Hard Boundaries

- Do not build a trading bot.
- Do not place, review, cancel, or dispatch real orders.
- Do not use unofficial or reverse-engineered Robinhood APIs.
- Do not store Robinhood credentials, tokens, private keys, account numbers, balances, positions, or raw portfolio data.
- Do not claim live trading support unless owner-provided evidence verifies the official Robinhood MCP flow.
- Default mode must be read-only, dry-run, and proposal-only.
- Options and high-risk trades must be blocked by default.
- Live mode must remain disabled by default and require explicit owner approval if scaffolded separately.

## Required Artifacts

- `README.md`
- `policy.example.json`
- `capability-manifest.json`
- `mcp-probe.example.json`
- `receipt.example.json`
- `guard-policy-preview.mjs`

## Required Behavior

The guard must emit one of:

- `allow_read_only`
- `require_owner_review`
- `blocked`

It must include receipt evidence for:

- Intent
- Policy decision
- Blocked reason or approval requirement
- No-live-order confirmation
- Confirmation that no unofficial Robinhood API was used

## Validation

Run:

```powershell
node robinhood-agentic-trading-guard/guard-policy-preview.mjs --assert
node --check robinhood-agentic-trading-guard/guard-policy-preview.mjs
node scripts/verify-integrations-json.js
git diff --check
```

Confirm every referenced path exists and no private account data or secrets are introduced.
