# Risk Fork Hackathon Demo

> **DEMO ONLY — LOCAL PROTOCOL SIMULATOR — NOT AN ISOLATION BOUNDARY — NO LIVE PROTECTION**

This source-only demonstration makes Risk Fork's deterministic classification,
fork lifecycle, taint boundary, cleanup evidence, and receipt checks visible
without contacting a provider. It accepts only named synthetic fixtures. It is
not a VM, container security product, kernel network control, arbitrary-code
sandbox, hosted service, or production MCP protection layer.

The flagship `e2b-malicious-mcp-containment` fixture composes the real
provider-neutral controller and E2B adapter with an injected in-memory SDK that
models the pinned `e2b` `2.39.0` contract. It is labelled **FAKE E2B — LOCAL
CONTRACT SIMULATION — NOT AN ISOLATION BOUNDARY**. Fake success is not E2B
qualification and makes no E2B call.

The demo entrypoint is pinned to this checkout:

```text
risk-fork/hackathon/bin/risk-fork-demo.mjs
```

Run it with the local Node executable. Never resolve a package runner or the
legacy `agoragentic-mcp` npm name for this demo.

From a source checkout, install the locked Risk Fork dependency tree before any
demo command:

```powershell
npm --prefix risk-fork ci --ignore-scripts --no-audit --no-fund
```

A verified offline kit already bundles that dependency closure. Do not run
`npm install` or `npm ci` inside an extracted kit.

## Status and claim boundary

| Claim | Value |
| --- | --- |
| Source available | `true` |
| Local demo available | `true` |
| Production ready | `false` |
| Live traffic protected | `false` |
| Authority granted | `false` |
| Provider calls | `0` |
| Network used | `false` |
| Credentials used | `false` |
| Clean commit performed | `false` |
| Published to npm | `false` |
| Hosted demo enabled | `false` |
| Selected future provider | `e2b` |
| E2B provider status | `not_live_qualified` |
| Production qualified | `false` |
| Live Agoragentic traffic protected | `false` |

Product claim: **Hackathon demonstration only. Not production-qualified. No
live Agoragentic traffic is protected.**

The machine-readable form is [demo-status.json](./demo-status.json). If a run
cannot preserve these claims, it must fail instead of weakening them.

## What happens during a run

```text
agent or attendee
  -> local stdio connector
  -> closed, host-owned fixture lookup
  -> deterministic Risk Fork classification
  -> host-owned provider profile from the closed fixture
  -> local reference copy or injected fake-E2B contract when policy requires one
  -> tainted candidate and bounded import checks
  -> destruction request and separate absence verification
  -> prepared-not-committed result and sanitized receipt
  -> local Flight Recorder replay
```

The connector is host middleware, not prompt text. The model may request only a
named fixture. The host owns the fixture metadata and determines whether the
classifier requires a fork. No prompt may grant execution authority, select a
provider, supply a risk label, add a remote target, or bypass cleanup.

LOW and DENY fixtures do not allocate a fork. HIGH fixtures use the constrained
local reference adapter except the closed flagship fixture, which uses the
injected fake-E2B contract. IRREVERSIBLE fixtures are prepare-only. The demo
never performs a clean commit or the represented external action.

## Commands

All examples run from the repository root:

```powershell
node risk-fork/hackathon/bin/risk-fork-demo.mjs doctor
node risk-fork/hackathon/bin/risk-fork-demo.mjs plan --scenario e2b-malicious-mcp-containment
node risk-fork/hackathon/bin/risk-fork-demo.mjs run --scenario e2b-malicious-mcp-containment
node risk-fork/hackathon/bin/risk-fork-demo.mjs serve
node risk-fork/hackathon/bin/risk-fork-demo.mjs config --client codex
node risk-fork/hackathon/bin/risk-fork-demo.mjs config --client codex --yes
node risk-fork/hackathon/bin/risk-fork-demo.mjs cleanup
node risk-fork/hackathon/bin/risk-fork-demo.mjs verify-offline-kit
```

- `doctor` checks the local runtime and reports a hash-bound, redacted reference
  for the owned demo root. It writes nothing and does not print the absolute
  root path.
- `plan --scenario <id>` validates a named fixture and previews its bounded
  path. It writes nothing.
- `run --scenario <id>` runs one synthetic fixture and records sanitized local
  evidence.
- `serve` starts the token-protected Flight Recorder on a random loopback port.
- `config --client <client>` prints a proposed local stdio configuration.
- `config --client <client> --yes` writes only a reviewable configuration
  artifact beneath the marker-bound demo root. It does not modify a client's
  real configuration.
- `cleanup` targets marker-bound demo paths beneath the owned root and
  verifies absence separately.
- `verify-offline-kit` verifies the kit manifest and runs its offline checks.

Supported configuration targets are generic stdio MCP (`generic`), Codex
(`codex`), Claude Desktop (`claude`), and Cursor (`cursor`). Generated
configurations execute the local Node binary with the
absolute path to `risk-fork/hackathon/bin/risk-fork-demo.mjs`; they do not use a
registry package. Every generated target carries the exact primary status
`generated_not_client_verified`. Codex carries the bounded detail
`codex_config_generated_not_live_client_verified`; it does not claim a syntax
or live-client check.
None of those labels prove that a participant's client connected.
After reviewing the artifact, the owner must manually merge it into the current
client's documented local MCP configuration and restart that client if required.

## Synthetic fixture catalog

The closed catalog contains:

- `low-read-only`
- `elevated-owner-policy`
- `high-filesystem-write`
- `high-incomplete-metadata`
- `high-untrusted-discovery`
- `high-prompt-injection`
- `e2b-malicious-mcp-containment` (flagship fake-E2B malicious stdio MCP)
- `irreversible-deployment-proposal`
- `deny-owner-policy`
- `cleanup-unknown`
- `stale-governance-binding`
- `malformed-lifecycle-receipt`
- `attack-traversal`
- `attack-link`
- `attack-secret`
- `attack-oversized-write`
- `attack-timeout`
- `attack-concurrency`

These IDs are test data, not general tools. The connector rejects arbitrary
commands, executables, paths, URLs, credentials, provider options, and unknown
fixture IDs.

## Default limits

- One active run.
- Ten completed runs between explicit cleanup resets. This is not a once-per-day
  allowance and there is no daily quota in the local demo.
- 128 fixture files and 4 MiB per workspace.
- 256 KiB per synthetic write.
- 50 actions.
- 60-second fork TTL.
- The closed fake-E2B flagship instead requests one 180-second sandbox timeout,
  one allocation, no retry, no fallback, no inherited environment, no mounts,
  no public ingress, and no external/provider network.
- 10-second execution timeout.
- 4 MiB cumulative recorder history, enforced against marker-bound owned-tree
  evidence before the next record is persisted.
- 64 MiB total owned demo root.
- No credentials, provider calls, network egress, remote targets, arbitrary
  executables, or clean commit.

Whenever a savepoint or fork was allocated, the demo requests its destruction
on success, error, timeout, interruption, and shutdown, verifies absence
separately, and reports the result. LOW/direct and DENY paths allocate no
savepoint or fork and make zero adapter calls; their savepoint/fork cleanup
fields explicitly report `cleanup.requested=false`,
`cleanup.absence=not_applicable`, `cleanup.status=not_applicable`, and
`savepoint_status=not_allocated`. A temporary owned run bookkeeping workspace
may still be created, and its removal is independently reported by
`owned_run_cleanup` (normally `verified_absent`). Cleanup that is `unknown` or
`failed` is a failure, not a successful deletion claim.

## Storage and deletion

The Git repository stores source, not runtime forks. This draft source branch is
public on GitHub; its generated kit remains local until a separate publication
action is authorized. GitHub contains only explicitly committed source;
synthetic savepoint, fork, recorder, and receipt data stays on the participant's
machine beneath the marker-bound demo root identified by the redacted reference
from `doctor`. It is not saved to AWS, E2B, Agoragentic, a VM, or a hosted
database.

Automatic cleanup is bounded to owned fixture paths. It never recursively
deletes a home directory, repository root, broad temporary directory,
participant workspace, unresolved path, or path without the expected ownership
marker. Local absence evidence is not a production deletion SLA.

## Open-source and abuse boundary

The public Risk Fork core and this demo are licensed under Apache-2.0. Future
distributions must carry the license and applicable [NOTICE](../NOTICE)
attribution, and modified files must be marked as changed. Earlier Git revisions
made available under MIT remain under their original license terms. No source
license or manifest can prevent someone from creating a harmful fork. The signed
commit, deterministic manifest, and SHA-256 checks distinguish the official
reviewed kit from modified bytes. The closed fixture catalog, one-run concurrency
gate, ten-run cleanup-reset quota, byte/action limits, no-credential contract,
and network guard constrain the official demo only. They are not DRM, malware
prevention, or control over third-party forks.

## Flight Recorder

`serve` visualizes a lifecycle replay whose persisted demo-receipt hash and
outer-record bindings are recomputed before serving. The result field
`network_used: false` means no external or provider network; this command does
use local loopback transport. It binds only to
`127.0.0.1` on an operating-system-selected port, requires its run token, uses a
restrictive Content Security Policy and origin checks, and loads no external
assets. The recorder labels execution as `local_reference_protocol_execution`
or `fake_e2b_protocol_execution` and always shows `isolation_boundary: false`.
For the flagship it also shows parent before/after hashes, Savepoint Capsule,
synthetic sandbox ID, eight boundary-evaluated synthetic attack outcomes, typed
result, separate kill and absence evidence, runtime, the prompt-pinned maximum
estimate `$0.005850`, and
provider-finalized cost `unknown`. It does not create a hosted dashboard or
make either local profile more isolated.

The exact proposed one-shot live canary is documented in
[E2B_LIVE_CANARY_PLAN.json](./docs/E2B_LIVE_CANARY_PLAN.json). It remains blocked
by a compile-time false source gate and requires a separate owner approval. The
offline tranche contains no executable provider path and does not read an E2B
key.

## Attendee safety

Use only the included synthetic fixtures. Do not supply an API key, wallet,
token, account, production workspace, private repository, customer data, or
secret. Do not point the demo at live MCP servers or other remote targets.

Start with the [five-minute quickstart](./docs/QUICKSTART.md). For cleanup and
recovery, use [CLEANUP_TROUBLESHOOTING.md](./docs/CLEANUP_TROUBLESHOOTING.md).
For the talk track, use [PRESENTER_SCRIPT.md](./docs/PRESENTER_SCRIPT.md).
The public machine card is
[risk-fork-capability.json](../discovery/risk-fork-capability.json), and the
agent-use boundary is [skill.md](../discovery/skill.md).
