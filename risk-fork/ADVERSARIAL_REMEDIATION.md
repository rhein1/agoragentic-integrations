# Risk Fork adversarial remediation record

## Scope and disposition

- Audited head: `64b79ff17679ba89eb75b9794e33a63f41fddf75`
- Branch: `codex/risk-fork-v1-20260811`
- Review surface: Risk Fork protocol, adapters, MCP pre-discovery boundary, clean commit, receipts, concurrency/crash behavior, and repository validation
- Disposition: PR #298 remains **draft and blocked**

This record separates falsifying baseline evidence from the local remediation checkout. It records local validation only; it does **not** claim pushed-head GitHub CI. Risk Fork is not production-ready, is not deployed or published, and does not currently protect live Agoragentic MCP or Harness traffic.

## Failing-before evidence

The adversarial regressions were run against the exact audited head before remediation:

| Area | Baseline result | Defect demonstrated |
| --- | --- | --- |
| E2B security boundary | `node --test test/e2b-security-boundary-remediation.test.mjs`: 0 passed, 26 failed | The snapshot-to-create design could not prove a filesystem-only child free of inherited environment, credential, process, socket, entropy, and mount state |
| MCP trust and receipt binding | `node --test test/mcp-receipt-remediation.test.mjs`: 0 passed, 14 failed | Trust lowering lacked exact attestation binding, unknown methods were not preserved as bounded `HIGH` decisions, and receipt commit/destruction claims were not fully cross-bound |
| Atomic clean commit | `node --test test/atomic-clean-commit-remediation.test.mjs`: 10 test nodes, 1 passed, 9 failed | Parent-head, current-governance, deletion-policy, authorization-consumption, and concurrent-consumer invariants were not one authoritative atomic boundary |
| Client-count evidence | `node scripts/verify-client-distribution.mjs`: failed | The registry contained 106 integrations while the SVG still displayed 105 |
| Adapter conformance CI | 105 of 106 adapters completed | The Hermes worker exited with code 0 and no stderr before the parent observed the IPC result, so the run was reported as failed |

These are deliberate failing baselines, not evidence that the remediated head has passed.

Additional failing-first regressions captured during the independent remediation review proved and then closed: serialized MCP-attestation time backdating; serialized clean-commit and authorization time backdating; capsule or authorization expiry while the final asynchronous clean-side gates were still running; stale governance during durable parent reservation; approval revocation and evidence rotation at the final parent gate; forged or mismatched authorization-verifier evidence; missing clean-side required-test verification; stale file locks after process death; receipt risk-summary substitution; and worker result loss without a request-bound ACK. These tests remain in the final suite rather than being weakened or deleted.

## Working-tree remediation

| Area | Remediation | Current claim boundary |
| --- | --- | --- |
| E2B | Public savepoint, fork-create, and execution entrypoints throw `E2B_SECURE_SNAPSHOT_PROFILE_UNAVAILABLE` before verifier, SDK, or provider I/O; production-relevant capabilities are false or unverified | Fail-closed refusal only; no usable E2B environment and no live containment qualification |
| Local adapter | Existing authority-free manifest checks and closed child-operation vocabulary remain the reference path | Functional protocol simulator only; no VM/container/firewall/kernel isolation claim |
| MCP discovery | An optional injected planner is awaited before the real loopback server receives `server/discover` and before its response is accepted | Ordering proof for an explicitly injected seam only; existing runtime callers omit it and hosted interception is not enforced |
| MCP trust | Trust lowering requires exact server/origin, registry version, fresh attestation, trusted attestor, exact attestation hash, integrity bindings, the original live trusted-verifier boundary, and a clean-host clock; raw `verified` metadata or caller-supplied evaluation time cannot lower trust | Deterministic contract behavior only; no production trust service is bundled |
| Unknown MCP methods | `UNKNOWN` preserves a bounded raw method and classifies `HIGH` | Classifier coverage only; production interception remains separate |
| Receipts | Commit and destruction claims are bound to exact lifecycle events, hashes, provider/fork references, and accepted artifact digest; authoritative verification additionally requires and verifies the exact full risk decision, plus the original live trust verifier whenever trust lowering was recorded | Structure-only validation remains explicitly separate; neither API makes the receipt authority, creator authenticity, settlement, or certification proof |
| Taint gate and required tests | Public artifact verification is structural/canonical and does not reconstruct current workspace policy from child paths or assume deletions are allowed; child test claims cannot satisfy current required-test policy without clean re-execution or a trusted external attestation exact-bound to the artifact, diff, and policy | The injected test verifier is a trusted clean-side boundary, not evidence supplied by the child |
| Clean commit | The concrete file parent transaction owns parent head, persisted current governance, and exact one-use approval under one per-parent lock through the accepted effect; consequential execution nests the concrete file authorization transaction as the sole local revocation/use authority, with signature/integrity/exact-binding verification before consume-and-execute; authoritative clocks are out of band and arbitrary callback/duck-typed authorities are rejected | Included file-backed transactions are single-filesystem durability/reference implementations, not a distributed production authority |
| Client count | A source-derived banner generator/check synchronizes the SVG and PNG evidence with the registry count | Generated-distribution consistency only; no product readiness claim |
| Adapter worker | A request-correlated result/ACK protocol makes the child hold its terminal exit until the coordinator acknowledges the exact evidence; the coordinator requires ACK delivery completion and a consistent worker exit, with no post-exit timing grace | Deterministic process-ordering repair only; GitHub CI on the pushed head is still required |

## Validation status

The final remediation surface contains **195 Risk Fork tests**. On the exact local checkout, `npm test` passed 195/195, `npm run check` checked 20 JavaScript files, `npm run self-test` completed with `prepared_not_committed`, `credentials_used:false`, and `network_used:false`, and `npm run pack:dry` succeeded. Pushed-head CI is authoritative only for the exact commit shown on PR #298 and must be checked there. These green results do not erase the failing-before evidence above or establish production readiness.

## Required follow-ups

Production readiness remains blocked on all of the following:

1. Close [#301](https://github.com/rhein1/agoragentic-integrations/issues/301): wire and verify hosted MCP/Harness interception before `server/discover`, then adversarially qualify initialize/list/read/get/call, redirects, negotiation failures, retries, malformed frames, early responses, and untrusted content handling. The disabled-by-default test seam is not enforcement.
2. Close [#302](https://github.com/rhein1/agoragentic-integrations/issues/302): design a sanitized filesystem-only E2B boot path that demonstrably excludes inherited environment variables, credential files, process tokens, random/nonce state, sockets, and persistent writable mounts; independently review it before any owner-authorized bounded live containment canary.
3. Close [#303](https://github.com/rhein1/agoragentic-integrations/issues/303): replace local file transactions with a durable distributed parent-head and execution-authorization transaction authority, including atomic compare-and-set, one-use consumption, crash recovery, retention, reconciliation, and operator-visible ambiguous outcomes.
4. Run the complete Risk Fork, Transaction Assurance, repository, packaging, schema, concurrency, crash-injection, and Node 20/22/24 CI matrix against the final pushed commit. Keep PR #298 draft and blocked until the evidence is reviewed.

## Benchmark interpretation

All checked-in benchmark output is **local orchestration overhead only**. A reported sub-millisecond “fork start,” including the previously observed 0.549 ms value, is a local reference-adapter measurement and cannot represent E2B environment creation, MicroVM launch, cloud fork latency, containment, provider cost, or a production SLO.

## No-go claims

Until the follow-ups above are complete and independently reviewed, do not claim that Risk Fork:

- protects live Agoragentic MCP or Harness traffic;
- provides a qualified E2B containment boundary;
- turns the local adapter into security isolation;
- supplies a production distributed transaction authority;
- is ready to merge, deploy, publish, enable, or route production traffic.
