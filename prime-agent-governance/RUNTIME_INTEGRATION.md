# Prime Agent Agent OS runtime integration

Status: source-only compatibility contract. No runtime process is launched.

## Architecture

```text
Prime Agent extension
  └─ observes and governs host-visible lifecycle and tool events

Agent OS runtime contract
  └─ builds closed request and validates plan/evidence integrity

Future restricted executor
  └─ owns process, sandbox, mounts, egress, credentials, payments, stop/revoke, and recovery
```

The two package surfaces deliberately meet only through hashes and opaque references. The extension does not receive provider credentials, wallet material, or unrestricted Agent OS control-plane access.

## Exact host pin

```text
PrimeIntellect-ai/prime-agent
v0.7.1
95afd319a78ae017a41241d50b013d656a0685ce
Node >=22.8.0
prime-agent --mode rpc
JSONL LF framing
```

The host pin matches the deterministic extension fixture. Any change to the host tag, commit, engine, mode, framing, or package-discovery contract blocks plan validation.

## Request contract

`buildPrimeAgentRuntimeRequest()` emits `agoragentic.agent-os.prime-agent-runtime-request.v1` with:

- owner, workspace, deployment, and principal scope;
- sandbox and Harness policy refs;
- optional exact authority ref;
- model, provider, and credential-profile refs;
- immutable runtime-image ref and digest;
- governance package ref and integrity hash;
- opaque MCP profile ref;
- bounded turns, tokens, wall-clock duration, and child count;
- optional autonomous, heartbeat, and schedule intent;
- mandatory receipt and Transaction Assurance requirements;
- `private_only` exposure.

Unknown fields, secret-like values, public exposure, paid activation fields, oversized identifiers, invalid refs, and invalid hashes fail closed.

## Validation contract

`validatePrimeAgentRuntimePlan()` independently checks:

- exact schema, adapter, host pin, and command preview;
- plan hash recomputation;
- normalized closed request shape;
- all-false authority flags;
- the exact `launch_allowed:false`, `runtime_executed:false`, `no_spawn:true`, `no_network:true`, `no_spend:true`, and `authority_granted:false` boundary;
- decision and review-reason consistency.

`validatePrimeAgentRuntimeEvidence()` independently checks:

- the exact closed evidence field set, secret-like value rejection, and evidence hash;
- exact adapter identity, decision, blocker count, and review-reason count;
- binding to the same plan hash and host pin;
- command, Harness policy, sandbox profile, runtime image, and governance-extension hashes against the validated plan;
- explicit false execution, process, network, spend, and authority claims;
- public-safe status.

Recomputing `evidence_hash` cannot legitimize an added credential, authority grant, payment or settlement claim, wallet field, unrestricted provider output, or any other undeclared field. The plan validator applies the same closed-shape and secret-like-value checks to the plan, RPC contract, and integration references.

`buildPrimeAgentCompatibilityPacket()` combines those validations with the package descriptor. It always keeps `runtime_verified:false`, `runtime_executed:false`, `authority_granted:false`, and `partnership_claimed:false`.

## Activation gates

A later executor integration must not remove the source inventory hold until an independently reviewed restricted Linux host run proves:

1. exact Prime Agent and immutable runtime image;
2. real extension loading through the Prime package loader;
3. real RPC prompt, abort, state, observe, unobserve, EOF, malformed-frame, and shutdown behavior;
4. external filesystem and network enforcement;
5. external credential brokering and zero credential persistence in the model-controlled kernel;
6. owner stop, pause, revoke, reconnect, and crash recovery;
7. idempotent mutation commands and evidence-bound uncertain-effect recovery;
8. bounded per-child authority and evidence-gated child completion;
9. Transaction Assurance and payments-assurance evaluation before paid autonomy;
10. no implicit public runtime, listing, x402, settlement, wallet, or trust activation.

## Future restricted Linux executor checklist

This checklist belongs to a separate, owner-authorized executor change. Nothing in this source-only contract satisfies an item below, and checking an item must link a reviewable artifact from the same immutable run.

### Immutable inputs and preflight

- [ ] Record Prime Agent repository `PrimeIntellect-ai/prime-agent`, tag `v0.7.1`, and commit `95afd319a78ae017a41241d50b013d656a0685ce`; reject any mismatch.
- [ ] Record Node `>=22.8.0`, the immutable Linux runtime-image digest, and the `@agoragentic/prime-agent` package digest; reject floating image or package refs.
- [ ] Verify the package loader resolves `pi.extensions` to `./index.mjs` and the `pi-package` keyword from the pinned package without modifying either artifact.
- [ ] Persist a preflight plan whose current source-contract boundary is exactly `launch_allowed:false`, `runtime_executed:false`, `no_spawn:true`, `no_network:true`, `no_spend:true`, and `authority_granted:false`, with every `authority_flags` value `false`.
- [ ] Require an explicit owner decision for the executor run. Source-contract validation, inventory-hold status, CI, or a local preview is not execution authority.

### Linux containment

- [ ] Launch as an unprivileged UID/GID in a fresh process namespace with a read-only root filesystem and no Docker, container-runtime, host PID, device, or control sockets mounted.
- [ ] Mount only the declared workspace and private session directory; prove traversal, undeclared mount, symlink-escape, and host-home access attempts are denied.
- [ ] Enforce CPU, memory, process-count, file-size, and wall-clock limits outside Prime Agent; capture the limit configuration and deterministic termination evidence.
- [ ] Apply and record the external syscall/process policy; prove shell escape and undeclared child-process attempts fail closed.
- [ ] Start with deny-all egress. If a later owner grant permits bounded egress, enforce the exact destination, method, and lifetime outside the model-controlled process and capture denied-destination evidence.

### RPC and lifecycle

- [ ] Execute the exact argv `prime-agent --mode rpc --session-dir <AGENT_OS_PRIVATE_SESSION_DIR>` with `shell:false`; do not interpolate a shell command.
- [ ] Prove LF-delimited JSONL over stdin/stdout, diagnostics only on stderr, and no non-protocol stdout bytes.
- [ ] Exercise `prompt`, `abort`, `get_state`, `observe`, and `unobserve`, including duplicate, out-of-order, malformed-frame, oversized-frame, EOF, and clean-shutdown cases.
- [ ] Prove owner pause, stop, and revoke terminate or quarantine work within a declared bound and survive reconnect, worker crash, kernel crash, and supervisor restart.
- [ ] Prove child work receives narrower bounded authority and cannot be reported complete without evidence accepted by the external supervisor.

### Credentials, authority, and side effects

- [ ] Broker credentials outside the Prime Agent process and model-controlled kernel; prove raw credentials are absent from prompts, environment dumps, session files, logs, receipts, and error output.
- [ ] Bind every mutable action to principal, agent, session, tool call, capability, input hash, expiry, and one-time authority ID; prove replay and scope widening fail closed.
- [ ] Make mutation commands idempotent or assign an idempotency key; reconcile timeout and unknown-result cases before any retry.
- [ ] Keep payment, wallet, x402, settlement, deployment, publication, public exposure, and trust-mutation adapters disabled for the restricted-host proof.
- [ ] Run Transaction Assurance and payments-assurance checks only with deterministic no-spend fixtures; a local receipt must remain explicitly distinct from payment or settlement proof.

### Evidence and review exit

- [ ] Produce a bounded public-safe evidence bundle containing actor, UTC timestamp, executor commit, image and package digests, plan hash, policy hashes, test-vector results, and redacted artifact hashes.
- [ ] Preserve `runtime_executed:false`, `authority_granted:false`, and `runtime_verified:false` in this source-contract packet. Any later executor-run record must use a separate schema and must not rewrite this preview evidence.
- [ ] Obtain independent review of the exact run artifacts; self-tests, first-party CI, or a recomputed hash do not establish external compatibility.
- [ ] Keep the central inventory hold, package publication, marketplace listing, production deployment, and partnership claim as separate owner decisions after the evidence review.
