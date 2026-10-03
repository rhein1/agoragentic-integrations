# Local-test managed worker contract

**Source-only, default-off, no production qualification or live protection.**
`createManagedRiskForkWorker` is exported from `src/index.mjs` and restricted to
an enabled `local_test` control plane. It constructs no listener, SDK, database,
credential, or provider account. The package remains private and unpublished.

## Host-owned dependencies

Supply `controlPlane`, `providerRegistry`, distinct `executionPrincipal`,
`cleanupPrincipal`, and `recoveryPrincipal` slots, `workerId`, bounded `leaseMs`
and `maxAttempts`, and these trusted callbacks:

- `loadPrepareInput(invocation)`: reconstruct the actual controller preparation
  input from clean-host policy. Its operation must hash to the admitted exact
  operation. It must not perform the risky operation itself.
- `invokeProvider({ provider, method, input, context, signal })`: the privileged
  broker, not an agent callback. Enforce the absolute lease deadline/generation
  at the effect and tag creates with `provider_recovery_key` at birth. Never
  forward principals, lease/bearer tokens, provider credentials, or this host
  callback capability to the child. An in-process fixture is not such proof.
- `lookupResources({ provider, context, invocation, signal })`: observational,
  read-only lookup by exact tenant, provider binding, and recovery key. Return
  only `savepoint_ref`, `fork_ref`, `absent_resource_kinds`, `absence_evidence`.
  Partial/total absence requires the control plane's exact-bound provider
  attestation. No find/create fallback or original-operation replay is allowed.
- `measureCostMicros(admission, prepared)`: pure host metering with no provider
  effects. Return an integer between zero and the reserved estimate. Current
  lease/scope is checked again after this callback returns.

The context includes invocation, tenant, binding hash, recovery key, lease kind,
generation, and absolute expiry, but no raw authorization token. The driver
renews/rechecks authority before and after provider calls and after lookup/cost
waits. This rejects delayed responses; it cannot retroactively stop an effect
inside a broker that ignores the deadline. Broker fencing, cancellation, and
independent provider observation still require qualification.

## Execution ordering

`execute(invocation_ref)` coalesces duplicate callers into one logical attempt:

```text
fresh execution claim -> exact admitted operation -> actual controller.prepare
  -> create savepoint -> durably journal savepoint
  -> create fork      -> durably journal fork
  -> execute / validate result / destroy both / verify controller cleanup
  -> recheck lease -> pure cost measurement -> recheck lease -> settle outcome
  -> fresh cleanup claim -> fresh managed-plan absence verification
  -> terminal completed -> return original controller + prepared object
```

Both references must be journaled before `executeInFork`. Unknown creation or
journal acknowledgement stops further effects and marks the attempt uncertain.
The successful path does not destroy resources a second time: controller
preparation already destroyed them, so managed cleanup obtains fresh evidence
bound to its own cleanup plan. A failed observation does not import the result.
Public `cleanup(ref)` and restart recovery still destroy uncertain resources;
their broker/provider contract must safely reconcile already absent resources.

Returned `controller` and `prepared` are clean-host process-local capabilities,
never agent/HTTP payloads. The core still rejects clones, serialized prepared
objects, and objects from another controller. This worker never automatically
commits or mutates the parent. Any clean commit must use the original controller
and the existing exact-bound parent authorization gate.

## Ambiguity, restart, and shutdown

The worker creates fresh 32-byte CSPRNG claim tokens and stores raw values only
inside process-local attempt state. It never logs them. There is deliberately
no automatic claim, journal, or provider retry. The control plane already has
durable delivery receipts, but this reference driver does not yet durably retain
its own secret-bearing delivery attempt across a restart. Lost acknowledgement
therefore waits for lease expiry and reaping rather than guessing delivery.

After the control plane reaps an unfinished lease, `recover(ref)` takes a fresh
recovery claim and does provider lookup, not execution. Both-resource and partial
found/attested-absent recovery journal the known references then enter cleanup.
Total verified absence uses `completeRecoveryAbsence`. Neither path replays the
original operation or reconstructs a prepared-object provenance brand.

Promises for successful and failed attempts remain memoized. A failed cleanup or
recovery attempt requires expiry/reaping and a fresh worker instance, not another
call to the same instance. `maxAttempts` bounds retained entries; exhaustion fails
closed rather than dropping duplicate-work tombstones. Plan worker rotation and
durable obligations before using this as an operational service.

`close()` rejects new work and aborts the signal passed to provider/lookup
callbacks. Late responses fail the next fence; they cannot report completion.
Cancellation does not prove a provider resource stopped or was destroyed.
Recovery is still mandatory for unfinished durable invocations, and a callback
that never settles requires broker/operator recovery.

## Source evidence versus remaining production work

`test/worker.test.mjs` exercises the real controller with an in-memory provider:
immediate journaling, duplicate callers, no double destroy, lost journal
acknowledgement, both-found/partial/total-absence recovery without execution,
cleanup-attestation denial, operation substitution, expiry after a response,
shutdown, and scope withdrawal after metering. Existing
PostgreSQL worker-authority tests separately exercise the durable scope boundary.
Run `npm test` and `npm run check` in this directory; opt-in database tests require
an isolated test database and are not managed deployment qualification.

Distinct principal slots do not implement new least-privilege scopes: the existing
`worker:claim`/`worker:write` routes remain. Durable worker token delivery recovery,
qualified provider broker, absolute effect fencing, observational verifier
deadlines, split routes/roles, scheduled reaping, managed PostgreSQL operations,
redacted telemetry, and hosted conformance remain in
[DEPLOYMENT_GATES.md](./DEPLOYMENT_GATES.md). All returned production/live flags
remain false, regardless of source test success.
