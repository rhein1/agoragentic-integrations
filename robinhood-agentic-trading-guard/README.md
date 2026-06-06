# Robinhood Agentic Trading Guard

Public-safe Agoragentic / Triptych OS (Agent OS) guardrail scaffold for Robinhood's official Agentic Trading / MCP flow.

This integration is governance only. It evaluates proposed Robinhood-related MCP actions, returns a policy decision, and emits receipt-shaped evidence that confirms no live order path was invoked. It does not execute trades, place orders, use unofficial Robinhood APIs, store credentials, or store private account data.

## Status

- Status: experimental
- Default mode: read-only, dry-run, proposal-only
- Execution authority: none
- Live trading: disabled
- Official API stance: Robinhood MCP metadata only until owner-provided evidence verifies the official flow

## Safety Boundary

This guard is intentionally narrower than a trading integration:

- No trading bot behavior
- No order placement
- No unofficial or reverse-engineered Robinhood APIs
- No stored Robinhood credentials, tokens, account numbers, balances, positions, or raw portfolio data
- No live trading support claims without owner-provided evidence
- Options, margin, short selling, crypto, futures, event contracts, and other high-risk actions blocked by default
- Live mode remains disabled by default and would require explicit owner approval before any separate executor could be considered

Agoragentic provides the safety, policy, approval, receipt, and audit layer. Brokerage execution remains outside this integration.

## Files

- `policy.example.json` - default policy with read-only/proposal-only behavior
- `capability-manifest.json` - machine-readable capability boundary
- `mcp-probe.example.json` - public-safe metadata probe shape
- `receipt.example.json` - example receipt for a blocked options proposal
- `guard-policy-preview.mjs` - deterministic local policy preview and assertion script
- `prompts/codex-robinhood-agentic-guard-build.md` - build prompt for regenerating this integration safely

## Policy Decisions

The guard emits one of three policy decisions:

- `allow_read_only` - allowed metadata-only or public/read-only proposal
- `require_owner_review` - blocked from execution until explicit owner approval
- `blocked` - disallowed by default policy

Example:

```powershell
node robinhood-agentic-trading-guard/guard-policy-preview.mjs --sample read-only
node robinhood-agentic-trading-guard/guard-policy-preview.mjs --sample equity-order
node robinhood-agentic-trading-guard/guard-policy-preview.mjs --sample options-order
node robinhood-agentic-trading-guard/guard-policy-preview.mjs --assert
```

## Expected Outcomes

| Proposal | Decision | Reason |
| --- | --- | --- |
| Inspect MCP endpoint metadata | `allow_read_only` | Metadata-only, no account data, no order |
| Proposed equity order review/place action | `require_owner_review` | Owner approval required; no live order dispatched |
| Proposed options order | `blocked` | Options are high-risk and blocked by default |

Every decision includes receipt evidence for:

- Intent
- Policy decision
- Blocked reason or approval requirement
- No-live-order confirmation
- Confirmation that no unofficial Robinhood API was used

## Owner-Gated Next Steps

These steps remain out of scope for this public scaffold:

- Owner verifies the official Robinhood MCP schema and authentication flow.
- Owner supplies redacted evidence that the MCP server exposes the expected tools.
- Owner defines account-specific approval policy outside public artifacts.
- Any live executor is reviewed separately, remains disabled by default, and requires explicit owner approval.
