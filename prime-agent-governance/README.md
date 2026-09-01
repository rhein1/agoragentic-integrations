# Agoragentic Prime Agent extension

This source-only package puts a bounded Agoragentic policy and evidence boundary around Prime Agent lifecycle and tool events. Its declared and effective level remains `source_adapter`. A hash-bound provider-free run supports `runtime_compatibility` evidence for exact Prime Agent v0.7.2, but promotion is blocked by the captured high-severity `extract-zip` advisory; no public compatibility claim is made.

## Exact upstream pin

- repository: `PrimeIntellect-ai/prime-agent`
- tag / version: `v0.7.2` / `0.7.2`
- commit: `83a0f9f9566219551fcb6ffaf7f519a815749a58`
- asset: `prime-agent-0.7.2.tgz` (9,387,295 bytes)
- SHA-256: `bc5471f2a626d727b88a45eb745fff93b10c554a3c4fc5912f25d8c64b987f5e`
- Node.js engine: `>=22.8.0`
- CLI: `dist/bundle/cli.js`

The immutable verifier checks the tarball before extraction, then checks exact released package metadata, paths, dependency URLs, and a canonical first-party tree digest. The lightweight official tag resolves directly to a GitHub-verified signed commit. The release declares `./hooks` at `dist/core/hooks/index.js`, but that target is absent; the verifier records `published_hooks_export_target_missing` as a warning because the CLI extension path is independently testable.

Prime Agent v0.8.1 was observed as newer by the authoritative GitHub latest-release API at `2026-08-30T05:27:33.509Z`. That separately hashed snapshot never changes the v0.7.2 pin, executes a new binary, or promotes this integration automatically.

## Qualification

| Level | Result | Boundary |
| --- | --- | --- |
| `research_only` | evidence passed | Official release metadata identified. |
| `metadata_mapping` | evidence passed | Exact artifact and package metadata verified. |
| `source_adapter` | effective level | Deterministic and adversarial extension tests pass. |
| `policy_enforcement` | evidence absent | No real host tool-call interception was exercised. |
| `runtime_compatibility` | evidence passed; promotion blocked | Integrity-bound released CLI, dependency closure, and source extension passed the provider-free RPC matrix. The exact closure includes direct `extract-zip` 2.0.1, affected by high-severity `GHSA-jmr9-qjv8-65gv` with no patched version reported at capture time. |
| `exact_runtime_verification` | evidence absent | No restricted canary, active cancellation, recovery, or external chokepoint proof. |
| `hosted_availability` | evidence absent | No hosted endpoint observed. |
| `production_activation` | evidence absent | No deployment, activation, or owner promotion approval. |

The Marketplace companion record keeps `policy_enforcement_passed: false`. Policy enforcement and runtime compatibility are sibling evidence branches from the source adapter; neither is inferred from the other.

Evidence:

- `evidence/prime-agent-v0.7.2-qualification.v1.json`
- `evidence/prime-agent-v0.7.2-agent-os-qualification.v1.json`
- `evidence/prime-agent-v0.7.2-released-compatibility.v1.json`
- `evidence/prime-agent-v0.7.2-integrity-profile.v1.json`
- `evidence/prime-agent-v0.7.2-dependency-audit.v1.json`
- `evidence/prime-agent-v0.7.2-package-lock.json`
- `evidence/prime-agent-v0.8.1-release-observation.v1.json`

The packets retain false credentials, provider-call, spend, wallet, settlement, deployment, publication, outreach, public-compatibility-claim, trust, ranking, hosted, and production boundaries. The dependency advisory is a promotion blocker, not evidence that the provider-free compatibility matrix failed and not an action-boundary violation.

## Adapter behavior

The extension registers lifecycle and tool events; conservatively classifies read, write, network, spend, deploy, publish, trust, and unknown calls; binds high-impact actions to exact principal/session/action hashes; requires a host-trusted synchronous verifier; consumes grants once; fails closed when review or authority is unavailable; emits bounded redacted evidence; and exposes read-only `/agora-status` and `agoragentic_status` surfaces.

Local allowlists and UI confirmation cannot authorize spend, deploy, publish, or trust actions. The default export has no authority provider and denies every high-impact call.

## Released-host probe

The raw tarball is not standalone: its declared dependencies must be materialized before the CLI can load. The committed package lock plus schema-closed integrity profile pin the tested dependency closure. The profile records independently reproduced Node v24.13.0/npm 11.6.2 tuples for Windows x64 and Ubuntu 24.04 x64; the compatibility receipt identifies which platform tuple was actually executed. After immutable verification and isolated `npm ci --ignore-scripts`, the runner compares the first-party tree, dependency lock/tree, current Node version, and exact source-extension manifest before this provider-free probe runs. The launcher constructs a fresh allowlist-only child environment; it must not inherit caller credentials, provider configuration, or Prime Agent global state directories:

```text
HOME=<ISOLATED_TEST_HOME>
USERPROFILE=<ISOLATED_TEST_HOME>
APPDATA=<ISOLATED_TEST_HOME_APPDATA_ROAMING>
LOCALAPPDATA=<ISOLATED_TEST_HOME_APPDATA_LOCAL>
XDG_CONFIG_HOME=<ISOLATED_TEST_XDG_CONFIG_HOME>
XDG_DATA_HOME=<ISOLATED_TEST_XDG_DATA_HOME>
XDG_CACHE_HOME=<ISOLATED_TEST_XDG_CACHE_HOME>
XDG_STATE_HOME=<ISOLATED_TEST_XDG_STATE_HOME>
PI_OFFLINE=1
PI_SKIP_VERSION_CHECK=1
PRIME_AGENT_TELEMETRY=0
PRIME_AGENT_CODING_AGENT_DIR=<ISOLATED_TEST_CODING_AGENT_DIR>
PRIME_AGENT_SESSION_DIR=<ISOLATED_TEST_SESSION_DIR>
TMP=<ISOLATED_TEST_TEMP_DIR>
TEMP=<ISOLATED_TEST_TEMP_DIR>
AGORAGENTIC_NO_SPEND=1
AGORAGENTIC_ALLOW_REAL_SPEND=0
AGORAGENTIC_ALLOW_NETWORK_CANARIES=0

node <release-root>/dist/bundle/cli.js \
  --offline --mode rpc --daemon-socket <ISOLATED_TEST_SOCKET> \
  --no-session --no-builtin-tools --no-extensions \
  --no-skills --no-prompt-templates --no-themes --no-context-files \
  -e <local-extension-package>
```

Every run creates unique home/profile, XDG config/data/cache/state, coding-agent, session, temporary, working, and daemon-socket paths. `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, and the XDG roots are set to those paths rather than omitted, so operating-system fallback cannot resolve Prime configuration from the caller's real profile. It never reuses a caller or global Prime Agent daemon. After the foreground RPC process exits, bounded cleanup requests daemon shutdown and waits for the isolated socket or pipe endpoint to disappear before removing the runtime directory; cleanup failure blocks the result.

The matrix covers LF JSONL, idle state, extension discovery, `/agora-status`, idle abort, missing observe/unobserve behavior, malformed input, an unknown command, and EOF shutdown. It sends no provider prompt, uses no credentials, makes no paid provider call, and exercises no side-effecting tool. See `RUNTIME_INTEGRATION.md` for exact boundaries and later gates.

The hash relationship is acyclic: source manifest → integrity profile → released-host receipt → qualification evidence → Marketplace companion record. Runtime-plan inputs name and hash every member of that chain, and packet construction verifies their exact cross-fields. The downstream Marketplace consumer pins the final companion record; no downstream receipt, evidence, or record digest is compiled back into the source manifest.

## Validation

```bash
npm run check
npm test
npm run pack:dry
```

To include the immutable released-host probe, copy the committed evidence lock to the extracted package root, run `npm ci --ignore-scripts`, then set `PRIME_AGENT_V072_TGZ` and `PRIME_AGENT_V072_ROOT` before `npm test`.

Repository checks:

```bash
node --test test/integration-inventory-holds.test.mjs
node scripts/verify-integrations-json.js
node scripts/generate-integration-capability-status.mjs --check
node scripts/sync-integration-counts.mjs --check
```

The centrally owned hold remains in `integrations.json`; package-local evidence cannot publish, promote, grant authority, or remove that hold.

## Hard boundary

Prime Agent executes model-generated Python and project commands with the user's operating-system permissions. Its processes are not security sandboxes, and static classification cannot prove every nested side effect was observed. Payment-bearing or production use requires a restricted Triptych OS (Agent OS) lane with enforced network, filesystem, process, credential, and payment chokepoints.
