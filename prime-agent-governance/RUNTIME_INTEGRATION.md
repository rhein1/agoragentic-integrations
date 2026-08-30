# Prime Agent v0.7.2 runtime integration contract

The declared and effective level remains `source_adapter`. Current evidence supports `runtime_compatibility` for the source-only extension against the exact dependency-materialized Prime Agent v0.7.2 released CLI, but it is not a promotion candidate: the captured dependency audit blocks promotion because direct `extract-zip` 2.0.1 is affected by high-severity `GHSA-jmr9-qjv8-65gv` and no patched version was reported. No public compatibility claim is made.

## Immutable identity

| Field | Value |
| --- | --- |
| Repository | `PrimeIntellect-ai/prime-agent` |
| Tag / version | `v0.7.2` / `0.7.2` |
| Commit | `83a0f9f9566219551fcb6ffaf7f519a815749a58` |
| Asset / bytes | `prime-agent-0.7.2.tgz` / `9387295` |
| SHA-256 | `bc5471f2a626d727b88a45eb745fff93b10c554a3c4fc5912f25d8c64b987f5e` |
| CLI / Node | `dist/bundle/cli.js` / `>=22.8.0` |

`release-verifier.mjs` rejects size or digest mismatch before extraction and then checks exact released metadata, required paths, and a canonical first-party tree digest. The raw tarball is not standalone and stops at a missing `zeromq` import until declared dependencies are materialized. The committed evidence lock and schema-closed integrity profile fix the tested closure; the runner compares that lock, the platform-specific installed dependency count/tree, exact Node version, and exact source-extension manifest before spawn. The profile records Node v24.13.0/npm 11.6.2 tuples for Windows x64 and independently reproduced Ubuntu 24.04 x64 materializations. The published `./hooks` export target is also absent; the verifier emits `published_hooks_export_target_missing` while independently testing the supported CLI extension path.

## Provider-free command

The command is a launcher contract, not a shell snippet to run inside the caller's ambient environment. Construct an allowlist-only child environment containing only required operating-system launch keys plus the values below. Do not inherit credentials, provider configuration, caller Prime Agent directories, or a global daemon endpoint. Home/profile and XDG variables must be explicitly redirected to isolated per-run paths; merely omitting them allows operating-system home lookup to fall back to the caller's real profile.

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
node <release-root>/dist/bundle/cli.js --offline --mode rpc --daemon-socket <ISOLATED_TEST_SOCKET> --no-session --no-builtin-tools --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files -e <extension-root>
```

The home/profile directory, XDG config/data/cache/state roots, working directory, coding-agent directory, session directory, temporary directory, and daemon socket or named pipe are unique to each run. The launcher must never reuse a caller or global Prime Agent daemon. After the foreground RPC process exits, bounded cleanup requests shutdown through that exact isolated endpoint and waits for the socket or pipe to disappear before removing the runtime directory; a shutdown, endpoint-wait, or runtime-directory cleanup failure blocks qualification.

The isolated probe passes LF-only JSONL, idle state, extension discovery, `/agora-status`, idle abort, missing observe/unobserve behavior, malformed JSON, unknown command, and EOF shutdown. CRLF output fails the framing case. It uses no credential or provider prompt. Idle abort is not active-cancellation proof; EOF is not stale-worker recovery; the extension status command is not real policy interception.

## Evidence boundary

The provider-neutral packet keeps `policy_enforcement`, `exact_runtime_verification`, `hosted_availability`, and `production_activation` unsupported by evidence. It preserves the passed `runtime_compatibility` evidence while setting `promotion_blocked: true`, clearing the candidate level, and naming `dependency_security_audit` as the blocker. The Marketplace companion keeps both `policy_enforcement_passed: false` and `dependency_security_audit_passed: false`; deterministic/adversarial source tests do not replace real-host policy interception.

The committed public-safe compatibility receipt binds the observed release bytes, first-party tree, selected platform dependency lock/tree tuple, integrity profile, source-extension manifest, process output digests, and actual matrix outcomes. Its self-hash is evidence integrity, not cryptographic origin authentication, activation authority, or human promotion approval. Receipt creation accepts only the module-branded successful result returned directly by the exact released-host runner, derives `observed_at` from private runner provenance, and consumes that result once; static verification remains available for committed JSON.

The chain is intentionally acyclic: source manifest → integrity profile → compatibility receipt → qualification evidence → Marketplace companion record. A runtime request must carry refs and digests for the profile, receipt, evidence, extension manifest, and companion record. Packet construction verifies every supplied object, receipt-derived evidence refs, and record cross-fields. The final Marketplace consumer pins the record; no downstream hash is compiled into a source file covered by the extension manifest.

All runtime/exact/hosted/production, credential, provider-call, spend, wallet, settlement, deployment, publication, trust, and ranking flags remain false. Exact-runtime promotion requires owner-approved restricted process/filesystem/egress/credential/payment chokepoints plus real interception, active cancellation, recovery, and receipt evidence. Hosted and production levels require separate direct evidence and explicit owner approval.

Prime Agent v0.8.1 was observed as newer by a separately hashed authoritative GitHub API snapshot at `2026-08-30T05:27:33.509Z`, but the drift record changes no pin, executes no new binary, and performs no promotion.
