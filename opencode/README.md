# Agoragentic OpenCode Harness Plugin

`@agoragentic/opencode` is an experimental, source-only native OpenCode plugin that applies the existing Agoragentic Harness Core mapper/evaluator, approval, lifecycle-event, redaction, and local-receipt families around OpenCode tool calls.

It does not add tools, call Agoragentic APIs, access secrets, spend, settle x402, publish, deploy, provision, write hosted memory, or grant OpenCode any authority it did not already have.

## Current status

- Package version: `0.1.0` source candidate; not published to npm.
- Exact host target: OpenCode `1.18.15` only.
- Official source pin: `anomalyco/opencode@38e10eb1408feb700021b8e8766fb0ab41bf84e2`.
- Contract evidence: [`contracts/opencode-plugin-1.18.15.json`](contracts/opencode-plugin-1.18.15.json).
- Validation scope: hermetic contract fixture and direct hook tests, not an end-to-end OpenCode runtime compatibility result.

The package uses OpenCode's `./server` package entry and default `{ id, server }` module shape at that pin. Its `engines.opencode` range is exactly `=1.18.15`. OpenCode skips the npm compatibility gate for local `file:` plugins, so a source checkout still requires the operator to verify the host version.

## Hook boundary

The official pinned runtime invokes hooks in this order for a successful tool call:

```text
tool.execute.before
host tool execution
tool.execute.after
```

The before hook maps `{ tool, sessionID, callID }` plus mutable `output.args` into the Harness action family and returns one effective result:

| Harness result | Plugin behavior |
|---|---|
| `allow` | Records a bounded `before_tool` event and returns without changing tool arguments. |
| `ask` | Writes one bounded Harness approval packet and blocked local receipt, then throws before execution. A matching approved local decision allows a later retry. |
| `deny` | Writes a blocked lifecycle event and local receipt, then throws before execution. |

The after hook does not persist `title`, `output`, metadata values, tool arguments, session IDs, or call IDs. It stores only hashes, byte counts, value types, field counts, redacted stable references, duration, and explicit authority boundaries. An after hook without a matching governed before hook emits a blocked `ungoverned_after_without_before` receipt and disables further calls in that plugin instance; it never creates a successful receipt.

OpenCode `1.18.15` declares no tool-error after hook. If the host tool itself throws, the before event remains but this plugin cannot truthfully emit a successful completion receipt. Missing after evidence therefore remains unknown rather than being reconstructed.

## Local artifacts

Artifacts stay under the project directory:

```text
.agoragentic/
├── approvals/
│   ├── approval_<id>.json
│   └── approval_<id>.decision.json
└── opencode/
    ├── approval-refs/action_<id>.json
    └── runs/opencode_run_<id>/
        ├── events.jsonl
        ├── receipts/local_receipt_<id>.json
        └── handoffs/local_receipt_<id>.json   # only with memory_handoff=local_ref
```

Receipts use `agoragentic.harness.local-receipt.v1`. They are local policy/evidence records only. They are not settlement receipts, certifications, endorsements, trust signals, or marketplace verification.

## Source validation

From this repository:

```bash
cd opencode
npm ci
npm run check
npm test
npm pack --dry-run
```

No OpenCode process, network service, wallet, API key, or paid route is used by the tests.

## Source-checkout configuration

Use the included [`examples/opencode.json`](examples/opencode.json) only with the exact pinned host version. From the repository root it resolves the local package as `file:./opencode`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:./opencode",
      {
        "policy_file": "policy.yaml",
        "memory_handoff": "local_ref"
      }
    ]
  ]
}
```

`policy_file` must be a relative path contained by the OpenCode project directory. If the file is absent, the Harness evaluator's conservative defaults apply: known reads may proceed; writes, shell, network, delegation, MCP, and unknown tools require review; prohibited or destructive patterns are denied. A malformed or out-of-project policy path fails closed.

The `memory_handoff: "local_ref"` option writes a refs-and-hashes-only local handoff candidate after a successful receipt. It does not import Agoragentic Memory, call a Memory service, or claim that a Memory write occurred.

## Approval and retry

For `ask`, inspect the path in the thrown error and decide locally with the installed Harness Core dependency:

```bash
npx --no-install agoragentic-harness-core approvals show approval_<id>
npx --no-install agoragentic-harness-core approvals decide approval_<id> \
  --decision approve \
  --note "owner-reviewed local retry"
```

Retry the same tool action after approval. The approval lookup binds the hashed session reference, tool name, input hash, and policy hash, and the before hook consumes it for one retry attempt. A later identical action requires a fresh approval; changed input or policy also produces a different packet. Approving the local packet only removes this plugin's own `ask` block for that attempt; OpenCode permissions and every external authority boundary still apply.

## Deliberate omissions

This package registers no Agoragentic discovery, quote, execute, receipt-fetch, deploy-preview, x402, or hosted-memory tools. Those would require network or execution authority outside this issue's local Harness boundary. They can be added only with separate API-specific authorization and tests.
