# Agoragentic Harness Core

Harness Core is the open, local, no-spend bridge from a self-hosted or framework-specific agent into Triptych OS (Agent OS) preview. It is a policy, event, proof, and receipt harness around local agent runtimes, not a hosted executor.

It does not deploy infrastructure, spend funds, publish marketplace listings, create x402 paid routes, rank providers, expose private connectors, or grant Full ECF access.

## Selective OSS Scope

Harness Core is the open-source package boundary for policy, evidence, receipts, readiness, CLI, schemas, profiles, local run ledger, and host/framework adapters. It wraps existing agent frameworks instead of replacing them.

The canonical release boundary ships as [Selective OSS Release Scope](RELEASE_SCOPE.md). Public framework examples live in [Harness Core framework wrapping examples](https://github.com/rhein1/agoragentic-integrations/tree/main/examples/harness-core-frameworks) and cover LangGraph, CrewAI, MCP, Codex, Hermes, and the Rust reference runtime with preview/readiness-only authority flags.

## Install Locally

```bash
npm install
node packages/harness-core/bin/agoragentic-harness.mjs init
```

When published as a standalone package, the intended entrypoint is:

```bash
npx agoragentic-harness-core init
```

Version `0.2.0` is the middleware-kernel release: local run ledgers, lifecycle events, review artifacts, runtime metadata probes, context refs, profiles, schedule intent, and worktree-session evidence remain local and no-spend.

## Commands

```bash
agoragentic-harness init [template]
agoragentic-harness validate
agoragentic-harness proof
agoragentic-harness proof --record
agoragentic-harness run --profile local_no_spend --task "..."
agoragentic-harness loop seller-listing-readiness --once --write-inbox
agoragentic-harness schedule plan seller-listing-readiness --interval daily
agoragentic-harness schedule list
agoragentic-harness schedule due
agoragentic-harness worktree attach --path ../agent-worktree --branch codex/example
agoragentic-harness worktree status
agoragentic-harness worktree detach
agoragentic-harness review gates init --maker local_maker --checker owner_checker
agoragentic-harness review request --gate listing-readiness --maker local_maker --checker owner_checker
agoragentic-harness review decide review_<id> --decision approve --checker owner_checker
agoragentic-harness review list
agoragentic-harness export --to agent-os
agoragentic-harness listing check
agoragentic-harness guard check --policy guard-policy.json --action action.json
agoragentic-harness runtime probe --url http://127.0.0.1:8080 --contract agoragentic-rust-http
agoragentic-harness context import --from micro-ecf
agoragentic-harness context status
agoragentic-harness approvals list
agoragentic-harness approvals show approval_<id>
agoragentic-harness approvals decide approval_<id> --decision approve --note "local review"
agoragentic-harness runs list
agoragentic-harness runs show run_<id>
agoragentic-harness events tail --run run_<id> --limit 50
agoragentic-harness profiles list
agoragentic-harness profiles show local_no_spend
agoragentic-harness status --write
agoragentic-harness adapters
agoragentic-harness review init|list|status
agoragentic-harness review request --gate listing-readiness --maker <label>
agoragentic-harness review decide review_<id> --decision approve --checker <label>
agoragentic-harness tools manifest init
agoragentic-harness tools list
agoragentic-harness tools inspect agent_os.preview_submit
agoragentic-harness improve suggest
agoragentic-harness improve decide improve_<id> --decision accept
agoragentic-harness owner-inbox
agoragentic-harness budget init|status
agoragentic-harness retry init|status
```

## Artifacts

Harness Core creates:

- `agent.yaml`
- `policy.yaml`
- `.agoragentic/runs/<run_id>/state.json`
- `.agoragentic/runs/<run_id>/events.jsonl`
- `.agoragentic/runs/<run_id>/local-proof.json`
- `.agoragentic/runs/<run_id>/local-receipt.json`
- `.agoragentic/runs/<run_id>/summary.md`
- `.agoragentic/local-proof.json`
- `.agoragentic/local-receipt.json`
- `.agoragentic/agent-os-harness.json`
- `.agoragentic/listing-readiness.json`
- `.agoragentic/guard-receipts/*.json` when `guard check --write-receipt` is used
- `.agoragentic/approvals/approval_<id>.json`
- `.agoragentic/runtime-probes/<probe_id>.json`
- `.agoragentic/context-imports/<source>.json`
- `.agoragentic/status.json` and `.agoragentic/status.md` when `status --write` is used
- `.agoragentic/owner-inbox.json` and `.agoragentic/owner-inbox.md` when the local loop writes an owner review packet
- `.agoragentic/review-gates.json` when local maker-checker review gates are initialized or used
- `.agoragentic/harness-schedule.json` when a local schedule intent is planned
- `.agoragentic/worktree-session.json` when a coding-agent worktree session is attached

The generated export packet matches `agoragentic.agent-os.harness.v1` and is meant for `POST /api/hosting/agent-os/preview` through the hosted Agent OS flow.

Harness projects may include `guard_policy` or `wallet_action_policy` in `policy.yaml`. Harness validates that budgeted or spend-capable packets have a Guard-style policy and exports that policy as preview metadata only. It does not sign transactions, call `/api/execute`, settle x402 payments, mutate wallets, or grant marketplace execution authority.

## Run Ledger

`agoragentic-harness run` records a local run ledger under `.agoragentic/runs/<run_id>/`. The ledger includes append-only events, state, run-scoped proof/receipt artifacts, and a Markdown summary. `proof --record` is an alias for the recorded run path. The legacy `proof` command still writes only `.agoragentic/local-proof.json` and `.agoragentic/local-receipt.json` for compatibility.

Local run receipts are not settlement receipts. They prove local policy checks and evidence capture only.

### Middleware Lifecycle

Adapter authors can import `executeHarnessRun` from `agoragentic-harness-core/kernel/run` and `MiddlewareRegistry` from `agoragentic-harness-core/kernel/middleware-registry`. A passing recorded run dispatches these hooks in boundary order:

```text
before_agent
before_policy
after_policy
before_tool
before_receipt
after_receipt
after_tool
before_export
after_export
artifact_written
after_agent
run_completed
```

Any hook through `after_agent` may fail closed before the run is marked passed. `after_export` receives the generated packet and local artifact path after the export is written; `before_export` runs before either exists. Hooks observe, validate, record, or block local work; registering middleware does not execute a framework or tool and grants no wallet, x402, marketplace, hosted runtime, provider, trust, public execute/invoke, private ECF, owner-bypass, shell, or process-control authority.

## Local Loop

`agoragentic-harness loop seller-listing-readiness --once --write-inbox` runs the `seller_listing_readiness` profile once, writes the normal run packet, refreshes status, writes the top-level Agent OS Harness export, runs the proposal-only listing readiness check, and writes `.agoragentic/owner-inbox.json` plus `.md` for owner review.

The owner inbox stores refs, statuses, blockers, pending approvals, and next owner actions only. It does not inline raw private payloads, raw prompts, raw tool outputs, private ECF payloads, secrets, or the full Agent OS export packet. It is not a scheduler and does not grant process-control authority.

## Local Schedule Intent

`agoragentic-harness schedule plan seller-listing-readiness --interval daily` records local schedule intent in `.agoragentic/harness-schedule.json`. `schedule list` shows planned loop intents. `schedule due` computes whether a loop is due from the latest passed matching local run and the planned interval.

The schedule layer is due-state metadata only. It does not start a background process, daemon, cron job, Task Scheduler job, systemd timer, hosted automation, shell, service, SSH session, tunnel, or loop run. A due loop must still be invoked manually with `agoragentic-harness loop seller-listing-readiness --once --write-inbox`.

## Worktree Session

`agoragentic-harness worktree attach --path <path> --branch <branch>` records which local coding-agent worktree, branch, optional commit SHA, optional PR ref, dirty-state label, and owner-review state the harness is reviewing. `worktree status` reads the local metadata plus latest Harness run ref. `worktree detach` marks the session inactive.

Worktree sessions are refs/status/receipt tracking only. Harness Core does not run `git`, create branches, push, open pull requests, execute shell commands, execute framework tools, dispatch providers, mutate hosted state, or write hosted memory.

## Maker-Checker Review Gates

`agoragentic-harness review gates init` creates `.agoragentic/review-gates.json` with a local `listing-readiness` gate. `review request --gate listing-readiness` records a pending maker-checker request with required evidence refs and blocked actions. `review decide <review_id> --decision approve|reject|needs_changes --checker <label>` records the checker decision.

Review decisions are local records only. They do not execute approvals, submit Agent OS previews, publish listings, activate x402, spend funds, mutate trust, dispatch providers, write hosted memory, bypass owner approval, or change public execute/invoke behavior. Approvals require explicit checker metadata; a maker cannot approve their own review as checker.

## Runtime Probe

`runtime probe` is a metadata/readiness check for local runtimes. It accepts loopback URLs only by default and uses HTTP GET for `/health`, `/.well-known/agent-card.json`, `/tools`, `/openapi.json`, and `/schema/agoragentic-rust-framework.json`. It does not invoke the agent, call `/api/execute`, call `/api/invoke`, make paid calls, shell out, dispatch providers, or provision hosted runtime.

Tool specs are sanitized before export and rejected if they imply wallet, x402, marketplace publication, trust mutation, provider dispatch, process control, global execute/invoke, private ECF export, or owner-approval bypass authority.

## Context Import

`context import` records references and hashes for Micro ECF or ECF Core artifacts. It does not inline raw source content, raw prompts, raw tool output, private ECF payloads, secrets, or raw database content.

## Approvals

Approval artifacts are local decision records only. `approvals decide` records approve/reject/edit intent and explicitly does not execute the requested action or bypass Agent OS owner approval controls.

## Live Enforcement (Claude Code)

Harness Core can enforce policy on a live Claude Code agent through a PreToolUse
hook — turning the policy from a description into an in-path gate. Before every
tool call, the hook maps the proposed action to a capability, scans it for prompt
injection / secret exfiltration / unauthorized-spend phrasing, checks it against
`policy.yaml` (`denied_tools`, `blocked_paths`) plus built-in safe-by-default
rules, records a redacted decision to `.agoragentic/claude-code-hook-decisions.jsonl`,
and returns `allow`, `ask`, or `deny`.

It can only **block** — it never executes a tool, spends, settles, publishes, or
grants authority. Read-only tools are allowed; writes, shell, network, and MCP
calls require review; irreversible / publish / wallet actions are denied.

Enable it by adding the snippet from `agoragentic-harness hooks config` to your
`.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "npx agoragentic-harness-core hook pretooluse" }] }
    ]
  }
}
```

## Boundary

Harness Core is proposal and proof infrastructure only. It keeps all live authority outside the package:

- No hosted billing
- No cloud provisioning
- No marketplace publication
- No hosted runtime secrets
- No wallet custody
- No settlement or payout orchestration
- No router ranking or trust mutation
- No Full ECF internals
- No provider dispatch
- No public execute/invoke behavior changes
- No process control or arbitrary shell execution
