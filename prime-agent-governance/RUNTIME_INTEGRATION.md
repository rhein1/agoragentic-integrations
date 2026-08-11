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
- no-spawn, no-network, no-spend, and launch-disabled boundaries;
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
