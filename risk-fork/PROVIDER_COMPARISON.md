# Risk Fork provider comparison

This comparison records the v1 adapter decision. It began as a design-time assessment and is not a benchmark, procurement recommendation, provider endorsement, or proof of containment. A later owner-authorized, capped, one-shot E2B canary used a task key and returned `status: unknown`; the key was revoked and the result did not qualify the provider.

## Decision

E2B remains the first cloud adapter research target because its documented sandbox-create surface supports a clean-template composition that can separate:

1. authority-free source verification;
2. creation of an immutable, manifest-bound sanitized workspace export;
3. child creation from a pinned reviewed template with network and lifecycle options requested at birth;
4. fresh identity/entropy bootstrap;
5. bounded workspace upload, execution, evidence collection, kill, absence verification, and export cleanup.

The original reference path used **snapshot then create**, not the direct fork convenience endpoint. In the API surface reviewed for v1, however, a full sandbox snapshot did not provide evidence that the restored child excludes dangerous environment state, credential files, processes, sockets, entropy/nonce state, and persistent writable mounts. Requesting network and lifecycle options at child creation is necessary but does not close that inherited-state boundary.

The current adapter therefore has four explicit states: unavailable, configured-but-unqualified, qualification-evidence-present, and `evidence_present_activation_blocked`. When all five effective clean-template profile values are absent, `createSavepoint`, `createFork`, and `executeInFork` refuse with `E2B_SECURE_SNAPSHOT_PROFILE_UNAVAILABLE` before SDK or provider I/O; supplying only part of the profile throws a constructor `TypeError`. A complete configured profile has an offline/mock-tested path for sanitized exact-byte export, pinned-template birth, closed create options, bounded result import, kill/absence checks, and durable cleanup reconciliation. Same-UID boot claims remain diagnostic and cannot upgrade the seven inherited-state/fresh-entropy controls. The third state accepts and retains canonical qualification evidence, but evidence without detached qualification trust cannot become `qualificationEligible` or alter provider capabilities. Only exact evidence with `status: verified`, including the required signed external observer receipt and per-birth-control bindings, plus detached Ed25519 qualification trust from a distinct pinned verifier can become `qualificationEligible`; its signed SDK-integrity binding must match the exact installed `e2b@2.39.0` runtime bytes. Even then, the hard-false `E2B_LIVE_FORK_SOURCE_ENABLED` flag maps the capability state to `evidence_present_activation_blocked`: no checked-in state enables provider allocation or the dormant renewable provider-observed idle lease. No checked-in evidence reaches the trusted activation-blocked state, so the repository does not claim a qualified E2B production path. The one-shot live canary verified kill, terminal absence, and orphan reconciliation but failed before bootstrap and provider-control binding; no live first-instruction or IPv6 network denial, isolation, inherited-state absence, persistence, latency, idle TTL, or exact cost property has been qualified. The live-qualification work is tracked in [issue #302](https://github.com/rhein1/agoragentic-integrations/issues/302).

## Matrix

| Candidate | Relevant documented primitive | Birth-time restriction assessment | v1 adapter status | Conclusion |
| --- | --- | --- | --- | --- |
| **E2B** | [create sandbox](https://docs.e2b.dev/api-reference/sandboxes/create-sandbox), [delete sandbox](https://docs.e2b.dev/api-reference/sandboxes/delete-sandbox), plus rejected [snapshot](https://docs.e2b.dev/sandbox/snapshots) and [fork](https://docs.e2b.dev/api-reference/sandboxes/fork-sandbox) paths | The configured path creates from a pinned reviewed template and uploads only an independently re-read, exact-byte, manifest-bound workspace whose absence claims carry detached pinned trust; it does not restore a live source snapshot. Requested birth restrictions and provider state echoes are source/offline/mock-tested, not live containment evidence | Reviewed template/runtime artifacts, independent source verifier, and default-off owner-gated build/live harnesses are implemented. Windows evidence-producing runs now fail before claims/SDK/provider I/O pending exact DACL validation. One credentialed canary returned `unknown` with verified cleanup; no trusted qualification artifact is checked in and live allocation remains hard-disabled in source | **Research target only**; implementation exists, but production remains blocked on live containment, lifecycle, and cost qualification |
| **Daytona** | [Persistence](https://www.daytona.io/docs/en/persistence/), [network limits](https://www.daytona.io/docs/en/network-limits/) | Workspace persistence/forking is relevant, but the reviewed TypeScript fork path did not establish that network and TTL restrictions are inherited atomically before child startup | Research only; no adapter | Revisit after provider evidence closes the birth-time control window |
| **AWS Lambda MicroVM / Firecracker** | [Lambda MicroVM lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html), [Lambda MicroVM launch](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html), [Firecracker snapshot support](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md) | Strong low-level isolation/snapshot primitives exist, but there is no reviewed turnkey arbitrary running-agent fork API matching this package contract | Research only; no adapter | Possible infrastructure substrate, not a v1 adapter |
| **Local reference** | Repository implementation only | Closed operation vocabulary and minimal environment; no VM/container/firewall or kernel egress control | Implemented and locally testable | Protocol/conformance demonstration only |

## Minimum adapter qualification

A provider adapter is not `qualified` merely because it implements every method. Qualification requires reproducible evidence for all of the following:

- the immutable staged source bytes were independently reopened, scanned, and verified authority-free before upload, with reviewed runtime hashes and a detached signature from a pinned verifier;
- the child starts with a fresh agent/session/runtime identity, nonce namespace, and entropy state;
- a privilege-separated provider control plane or host supervisor—not the child UID—signs the exact inherited-state and entropy observations, with no child write access or reusable signing authority;
- credentials, wallets, signatures, approval state, and reusable bearer tokens are absent;
- network denial or an exact allowlist is effective from the first executable instruction;
- parent and child workspaces are independent and parent state does not change during child work;
- hard TTL, idle TTL, and maximum execution time are each enforced independently of client cooperation;
- child credentials are prohibited or separately proven short-lived and automatically expired;
- child outputs remain tainted and only supported commit artifacts cross the boundary;
- kill/delete request and subsequent absence verification are separate observations;
- savepoint/template cleanup is also verified;
- provider errors produce explicit failure/unknown state;
- logs and receipts exclude raw prompts, conversation, memory contents, secrets, provider tokens, and private local paths;
- concurrency and replay tests show one-use authorization consumption is atomic at the clean commit boundary.

Performance qualification additionally needs repeated live samples with sample count, region, provider/SKU, payload shape, warm/cold distinction, timestamp, error treatment, and percentile method. One failed-closed diagnostic sample observed 1,641 ms to allocation and 2,303 ms for cleanup; it is insufficient for a latency or throughput claim.

Cost qualification needs an owner-approved live account, quoted/current provider pricing, billable-unit accounting, cleanup verification, and a capped canary budget. The canary had a `$1.000000` software/provider cap and the console showed `$0.00` aggregate usage at observation time, but E2B supplied no finalized per-sandbox cost receipt. Cost therefore remains `unknown`, and this package makes no provider-cost claim.

## E2B implementation constraints

The current v1 adapter fails closed at savepoint allocation, child allocation, and execution unless an explicit clean-template profile and its clean-side verifier/journal dependencies are configured. The package includes reviewed template-definition, first-boot guard, bootstrap, fixed-runner, and runtime-contract artifacts. Its configured source/offline/mock-tested path:

- accept an injected SDK/client rather than reading or persisting credentials itself;
- requires a clean-side verifier to reopen and rescan the immutable exact staged bytes, verify reviewed bootstrap/runner hashes, and validate a detached Ed25519 source-absence signature against a pinned independent-verifier key before creating any provider resource;
- rejects memory-bearing source state and exports exact staged bytes through a hash-bound manifest instead of snapshotting live runtime state;
- creates the child from a pinned template with internet disabled, zero persistent mounts, empty environment/IAM inputs, and kill lifecycle requested before startup;
- remains unqualified unless closed canonical evidence is exact-bound to the pinned template/runtime/provenance, one synthetic sandbox, lifecycle/network/cleanup observations, bounded cost, and the exact `e2b@2.39.0` SDK integrity hash, then separately verified under detached pinned Ed25519 trust;
- forces all seven provisional inherited-state/fresh-entropy controls `unknown` and derives them only from a signed external receipt whose closed observer boundary and per-control evidence validate;
- treats the evidence self-hash as integrity only, never as qualification authority;
- compares the installed SDK package bytes with the signed integrity binding before SDK/provider use;
- retains the provider-observed `setTimeout` lease implementation for a future separately authorized activation design, but the hard-false source gate prevents every checked-in state from arming or renewing it;
- runs fixed controller-supplied bootstrap commands rather than child-supplied shell commands;
- passes bounded job data through a fixed file/transport contract and streams imported results under byte and time limits;
- treats child result/evidence files as tainted input;
- records allocation intent durably before provider creation, kills first, and independently verifies absence;
- tracks export and sandbox cleanup separately and poisons further allocation while either state is unresolved;
- returns `unknown` rather than fabricating evidence when the SDK/provider cannot establish a fact; and
- rejects credential-shaped source material and never emits matched secret bytes, raw provider logs, or private workspace paths.

The current conformance suite verifies unconfigured refusal, configured request construction, reviewed runtime artifacts, independent exact-byte verification, pinned-signature failures, qualification-trust and SDK-integrity failures, sanitizer/manifest binding, exact-byte upload, bounded result import, lease renewal/capping, stale/wrong-result rejection, cleanup poisoning, and restart reconciliation using offline fakes. Those tests prove orchestration and fail-closed semantics only. The separate live canary provides one positive kill acknowledgement plus terminal-absence/orphan-reconciliation observation; neither that record nor the tests prove E2B isolation, first-instruction or IPv6 egress denial, inherited-state absence, idle TTL, representative latency, or exact cost.

## Rejected shortcuts

- **Clone a live parent carrying credentials.** Snapshot convenience never overrides the no-authority invariant.
- **Create first, restrict network later.** This leaves an initial exfiltration window.
- **Trust one-call fork defaults.** Defaults are not evidence that the required policy was applied before startup.
- **Treat kill/delete success as destruction.** A separate provider observation is required.
- **Treat self-hashed evidence as qualification.** Evidence integrity is not verifier authority; qualification and source-absence claims require separate detached trust bound to pinned keys.
- **Load an unverified SDK after qualification.** The exact installed `e2b@2.39.0` bytes must match the signed SDK-integrity binding before provider use.
- **Use the local adapter as a cloud substitute.** It exercises protocol semantics, not isolation.
- **Infer price or latency from documentation.** Provider plans and runtime behavior are time-sensitive and require live, bounded measurement.

## Next live gate

The configured sanitized clean-template profile, reviewed runtime artifacts, independent verifier, and default-off harnesses are implemented. On 2026-08-25 UTC, one owner-authorized no-retry canary ran in a new capped project with no production secrets and a synthetic workspace. It created one sandbox, returned `status: unknown`, and verified positive kill acknowledgement, terminal absence, and orphan reconciliation; evidence hash `sha256:fa3c6cc861189b3453a0ca9c49efac2a3fe7ebf3cb7ab225a2e28b0489fe14e8`. It did not reach bootstrap/provider-control qualification, and it has no independent observer receipt or finalized per-sandbox cost. Its historical generic error hash cannot distinguish the initial provider-info fetch from its exact contract predicate; future evidence uses closed sanitized failure-stage/class enums while retaining legacy omission compatibility. Its key was revoked, and its consumed approval/run claims cannot authorize a retry. A later audit found that the retained canary evidence had been manually hardened but the source relied on ineffective Windows mode bits; the current source therefore fails closed on `win32` with `E2B_WINDOWS_EVIDENCE_DACL_UNVERIFIED` before claims, SDK loading, or provider I/O until exact DACL validation is implemented. [Issue #302](https://github.com/rhein1/agoragentic-integrations/issues/302) therefore remains open. Any later canary requires a separately reviewed remediation and fresh owner authority, must run on a supported evidence platform, and must still obtain independent first-instruction IPv4 and IPv6 witness/provider evidence, identity freshness and inherited environment/process/socket/mount absence, exact SDK bytes, hard and renewable idle lease behavior, process termination, sandbox absence, sanitized receipts, cleanup/reconciliation after injected failures, representative latency, and provider-finalized capped cost. An independent observer and a distinct qualification-trust verifier must sign the exact bindings; the harness must not sign its own authority. Until that gate passes, status remains **one live diagnostic failed closed with cleanup verified; containment qualification absent; production blocked**.
