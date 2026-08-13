# Risk Fork provider comparison

This comparison records the v1 adapter decision. It is a design-time assessment, not a live benchmark, procurement recommendation, provider endorsement, or proof of containment. No provider credential was read and no billable provider call was made for this work.

## Decision

E2B remains the first cloud adapter research target because its documented snapshot and sandbox-create surfaces suggest a composition that could separate:

1. authority-free source verification;
2. snapshot creation;
3. child creation from that snapshot with network and lifecycle options requested at birth;
4. fresh identity/entropy bootstrap;
5. execution, evidence collection, kill, absence verification, and snapshot cleanup.

The original reference path used **snapshot then create**, not the direct fork convenience endpoint. In the API surface reviewed for v1, however, a full sandbox snapshot did not provide evidence that the restored child excludes dangerous environment state, credential files, processes, sockets, entropy/nonce state, and persistent writable mounts. Requesting network and lifecycle options at child creation is necessary but does not close that inherited-state boundary.

The current adapter is therefore a **fail-closed safety stub**, not a mock-qualified cloud implementation. `createSavepoint`, `createFork`, and `executeInFork` refuse with `E2B_SECURE_SNAPSHOT_PROFILE_UNAVAILABLE` before SDK or provider I/O. Its production-relevant capability flags are false or unverified, and it cannot pass Risk Fork's production-mode gate. No live network denial, isolation, persistence, deletion, latency, idle TTL, or cost property has been qualified. The secure boot and live-qualification work is tracked in [issue #302](https://github.com/rhein1/agoragentic-integrations/issues/302).

## Matrix

| Candidate | Relevant documented primitive | Birth-time restriction assessment | v1 adapter status | Conclusion |
| --- | --- | --- | --- | --- |
| **E2B** | [Snapshots](https://docs.e2b.dev/sandbox/snapshots), [create sandbox](https://docs.e2b.dev/api-reference/sandboxes/create-sandbox), [fork sandbox](https://docs.e2b.dev/api-reference/sandboxes/fork-sandbox), [delete sandbox](https://docs.e2b.dev/api-reference/sandboxes/delete-sandbox) | Snapshot followed by create can request restrictions at birth, but the reviewed path does not prove a sanitized filesystem-only restore without inherited authority/process/runtime state | Fail-closed safety stub; allocation and execution unavailable; no live credentialed validation | **Research target only**; blocked on a secure snapshot profile and live qualification |
| **Daytona** | [Persistence](https://www.daytona.io/docs/en/persistence/), [network limits](https://www.daytona.io/docs/en/network-limits/) | Workspace persistence/forking is relevant, but the reviewed TypeScript fork path did not establish that network and TTL restrictions are inherited atomically before child startup | Research only; no adapter | Revisit after provider evidence closes the birth-time control window |
| **AWS Lambda MicroVM / Firecracker** | [Lambda MicroVM lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html), [Lambda MicroVM launch](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html), [Firecracker snapshot support](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md) | Strong low-level isolation/snapshot primitives exist, but there is no reviewed turnkey arbitrary running-agent fork API matching this package contract | Research only; no adapter | Possible infrastructure substrate, not a v1 adapter |
| **Local reference** | Repository implementation only | Closed operation vocabulary and minimal environment; no VM/container/firewall or kernel egress control | Implemented and locally testable | Protocol/conformance demonstration only |

## Minimum adapter qualification

A provider adapter is not `qualified` merely because it implements every method. Qualification requires reproducible evidence for all of the following:

- the source state was verified authority-free before snapshotting;
- the child starts with a fresh agent/session/runtime identity, nonce namespace, and entropy state;
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

Performance qualification additionally needs repeated live samples with sample count, region, provider/SKU, payload shape, warm/cold distinction, timestamp, error treatment, and percentile method. None are available here, so this package makes no latency or throughput claim.

Cost qualification needs an owner-approved live account, quoted/current provider pricing, billable-unit accounting, cleanup verification, and a capped canary budget. None were authorized here, so this package makes no provider-cost claim.

## E2B implementation constraints

The current v1 adapter fails closed unconditionally at savepoint allocation, child allocation, and execution. Any future usable E2B path must also:

- accept an injected SDK/client rather than reading or persisting credentials itself;
- require a trusted clean-side source-sanitization verifier before creating any reusable boot artifact;
- reject memory-bearing source state without a verified, hash-bound sanitation attestation;
- import only a demonstrably sanitized filesystem payload, never a memory/process/runtime snapshot;
- create the child with internet disabled, zero persistent mounts, and lifecycle configured before startup;
- remain production-ineligible while idle-TTL enforcement is absent or unverified;
- run a fixed controller-supplied bootstrap, never a child-supplied shell command;
- pass bounded job data through a fixed file/transport contract;
- treat child result/evidence files as tainted input;
- kill first, then independently verify absence;
- delete the snapshot/template separately and verify that absence;
- return `unknown` rather than fabricate evidence when the SDK/provider cannot establish a fact;
- never emit API keys, environment secrets, raw provider logs, or private workspace paths.

The current conformance suite verifies that unavailable entrypoints refuse before source-verifier, SDK, or provider calls and that authority-bearing operations still hit the shared authority validator. That proves refusal behavior only. It does not verify E2B option construction, snapshot sanitation, containment, destruction, or any infrastructure behavior.

## Rejected shortcuts

- **Clone a live parent carrying credentials.** Snapshot convenience never overrides the no-authority invariant.
- **Create first, restrict network later.** This leaves an initial exfiltration window.
- **Trust one-call fork defaults.** Defaults are not evidence that the required policy was applied before startup.
- **Treat kill/delete success as destruction.** A separate provider observation is required.
- **Use the local adapter as a cloud substitute.** It exercises protocol semantics, not isolation.
- **Infer price or latency from documentation.** Provider plans and runtime behavior are time-sensitive and require live, bounded measurement.

## Next live gate

A future implementation must first close [issue #302](https://github.com/rhein1/agoragentic-integrations/issues/302) with a sanitized filesystem-only boot profile that cannot restore environment variables, credential files, process-level tokens, random/nonce state, sockets, or persistent writable mounts. Only after that code and its offline tests are independently reviewed should an owner consider a bounded live canary in a new, capped provider project with no production secrets and a synthetic workspace. That canary would need to test first-instruction egress denial, identity freshness, TTL, process termination, fork absence, snapshot absence, sanitized receipts, and cleanup after injected failures. Until both gates pass, status remains **secure profile unavailable; live containment qualification not run**.
