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

The worker creates fresh 32-byte CSPRNG claim tokens and never logs them. Without
an optional delivery journal, its secret-bearing attempt state is process-local;
lost acknowledgement waits for expiry/reaping rather than guessing delivery.
There is no automatic claim, journal, or provider retry.

For restart-safe delivery, construct `createManagedWorkerDeliveryJournal` with a
host-owned 32-byte encryption key, key ID, namespace, worker ID, exact control
plane/principals, and a durable ciphertext store. Supply the branded journal to
the worker as `deliveryJournal`. It persists an AES-256-GCM sealed packet before
each claim/resource delivery, binding key/namespace/worker identity as additional
authenticated data. The journal does not persist cleartext operation data or
lease tokens; the key and decrypted packet remain trusted-host secret state.

After an unknown response, explicitly inspect `listPending` and call
`resumeDelivery(attempt_ref)`. Only the exact original claim or resource-journal
packet is resumable under current authority. Concurrent deliveries coalesce;
failed transport may be explicitly redelivered, never automatically retried.
Renewal, outcome settlement, cleanup completion, and recovery-absence completion
are not resumable journal methods. An acknowledged record is a retained tombstone,
not permission to start work again. Recovery never resumes a controller, invokes
a provider, replays the original operation, or reconstructs prepared provenance.

The optional `createPostgresWorkerDeliveryStore` is local-test-only and has its
own explicit migrator/schema/ledger, immutable persisted capacity and write-once
ciphertext records. All records, including acknowledged ones, count toward
`maxAttempts`; capacity exhaustion fails closed. Unknown transaction outcomes or
serialization conflicts are not implicit retry authority. Stable host key custody,
reviewed retention, rotation, restore, and runtime roles require qualification.
Closing the journal zeroes its key copy, not the caller's key or database rows.

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

Execution, cleanup, and recovery now require their distinct
`worker:<purpose>:claim` / `worker:<purpose>:write` scopes on separate internal
routes. Old generic worker credentials must be explicitly replaced, not widened.
A bounded, default-off reaper schedules control-plane sweeps only: it does not
destroy resources or manufacture provider absence proof. A default-off local host
composes this worker, delivery journal, reaper, and separate loopback ingress with
all dependencies supplied by the host. Qualified provider brokering, absolute
effect fencing, verifier deadlines, deployed roles, managed PostgreSQL operations,
redacted telemetry, and hosted conformance remain in
[DEPLOYMENT_GATES.md](./DEPLOYMENT_GATES.md). All returned production/live flags
remain false, regardless of source test success.
