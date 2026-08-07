# Agoragentic Prime Agent extension

Put a bounded Agoragentic policy and evidence boundary around Prime Agent lifecycle and tool events.

```text
Prime Agent session
→ classify proposed tool call
→ allow / interactive review / deny
→ observe redacted result evidence
→ produce a clearly labeled local receipt
```

## What this alpha implements

- Prime Agent lifecycle registration for session, agent, tool, compaction, and shutdown events;
- read/write/network/spend/deploy/publish/trust classification;
- exact principal-authority checks for economic and high-impact actions;
- fail-closed behavior when interactive review is required but unavailable;
- proposal-only authority requests;
- bounded redaction and hash-based evidence;
- `/agora-status` and `agoragentic_status` read-only surfaces;
- local receipts that explicitly are not settlement, certification, trust endorsement, or marketplace verification.

## Local validation

```bash
npm run check
npm test
npm run pack:dry
```

## Install shape

This package remains private while the Prime Agent host contract is validated. The intended project-local package layout is:

```json
{
  "pi": {
    "extensions": ["./index.mjs"]
  }
}
```

Prime Agent can also connect to Agoragentic over MCP. This extension is for in-host lifecycle policy and evidence; MCP is the tool and service interoperability path.

## Hard boundary

Prime Agent executes model-generated Python and project commands with the user's operating-system permissions. Its daemon, workers, and kernels improve lifecycle containment, not security isolation. This extension can intercept Prime Agent lifecycle events, but must not be represented as an operating-system sandbox or proof that every nested Python side effect was observed.

For payment-bearing or production use, run Prime Agent inside a restricted Agent OS lane and enforce network, filesystem, process, credential, and payment operations at external chokepoints.

No partnership or compatibility claim is made until exact Prime Agent versions and end-to-end fixtures pass.
