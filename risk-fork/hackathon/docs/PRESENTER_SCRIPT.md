# Risk Fork Hackathon Presenter Script

> **DEMO ONLY — LOCAL PROTOCOL SIMULATOR — NOT AN ISOLATION BOUNDARY — NO LIVE PROTECTION**

## Two-minute setup

1. Say: “Risky tool calls get a disposable computer contract, not access to the
   trusted parent. Today the E2B API is simulated locally; no cloud sandbox is
   being claimed.”
2. Run `doctor` and point to `provider_calls: 0`, `network_used: false`, and the
   exact safety banner.
3. Run `plan --scenario e2b-malicious-mcp-containment`. Point to HIGH,
   `BLOCK_DIRECT_ROUTE_TO_RISK_FORK`, and `before_remote_connect`.

## Three-minute containment run

Run:

```powershell
node risk-fork/hackathon/bin/risk-fork-demo.mjs run --scenario e2b-malicious-mcp-containment
```

Narrate the four lanes:

1. **Clean Parent** — compare the identical before/after hashes and show the
   Savepoint Capsule hash. The parent-only canary was never exported.
2. **Policy and Risk Decision** — show the unknown-server, prompt-injection,
   filesystem, environment, and network reasons that forced HIGH.
3. **Disposable Fork** — call it “Fake E2B, local contract simulation.” Show one
   synthetic sandbox ID, the 180-second cap, eight boundary-evaluated synthetic
   attack outcomes, TAINTED output, and the one closed typed result. Do not call
   it a MicroVM or treat the outcomes as OS/provider containment evidence.
4. **Evidence and Cleanup** — distinguish kill acknowledgement from two
   `getInfo` absence observations plus an exact metadata-list observation. Show
   the receipt hash, `$0.005850` maximum estimate, and finalized cost `unknown`.

Close with: “Hackathon demonstration only. Not production-qualified. No live
Agoragentic traffic is protected.”

## Audience onboarding

Attendees can use a verified source checkout or offline kit and generate a
review-only stdio MCP configuration. They must manually install it into their
agent client. The connector exposes only four closed tools and enumerated
synthetic fixtures; it accepts no arbitrary command, path, URL, repository,
credential, provider, or production target.

## Do not improvise

- Do not set `RISK_FORK_DEMO_E2B_ENABLED` or provide an E2B key.
- Do not call a provider, public MCP server, production system, wallet, or
  deployment target.
- Do not describe the fake SDK as live isolation, secure erasure, a provider
  receipt, deployed protection, or production qualification.
- If cleanup is `unknown` or `failed`, stop and show it as a blocked outcome.
