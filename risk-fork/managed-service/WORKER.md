# Local-test managed worker contract

**Source-only, default-off, no production qualification or live protection.**
`createManagedRiskForkWorker` is exported from `src/index.mjs` and restricted to
an enabled `local_test` control plane. It constructs no listener, SDK, database,
credential, or provider account. The package remains private and unpublished.

## Host-owned dependencies

Supply `controlPlane`, `providerRegistry`, distinct `executionPrincipal`,
`cleanupPrincipal`, and `recoveryPrincipal` slots, `workerId`, bounded `leaseMs`
and `maxAttempts`.

The worker, delivery journal and enabled local host reject overlapping stable
`key_id` values and mixed tenants before retaining delivery keys or opening any
listener. All three original principal objects and their scope arrays must be
immutable data and include their purpose's claim/write scopes. Authenticating
the same key twice does not create two identities. Principals are retained by
reference, not cloned: the control plane still rejects forged/serialized objects
and rechecks current persisted credentials for each operation. The local host
captures the validated assignments; changing its options later cannot substitute
a policy identity. This enforces one composition, not global credential
exclusivity or deployed least privilege. Broad credentials remain possible;
separate provisioning, runtime custody and rotation still require qualification.

Supply these trusted callbacks:

- `loadPrepareInput(invocation)`: reconstruct the actual controller preparation
  input from clean-host policy. Its operation must hash to the admitted exact
  operation. It must not perform the risky operation itself.
- `invokeProvider({ provider, method, input, context, effectFence, signal })`: the privileged
  broker, not an agent callback. Enforce the absolute lease deadline/generation
  at the effect and tag creates with `provider_recovery_key` at birth. After any
  queue, limiter or database wait, **await `effectFence()` immediately before the
  actual provider API call** and use its fresh context, not the earlier context.
  The callback is method/attempt-bound, one-use and invalid after the broker
  returns. It rechecks the lease, current credential/provider binding and, for
  new creation/execution, the original request-policy epoch. Never
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

## Optional host-owned dispatch policy

Supply the original `createManagedRequestPolicy()` object as `requestPolicy`.
For a direct worker call, obtain the original execution decision from
`requestPolicy.beforeMutation({ principal: executionPrincipal, routeClass:
'execution' })`, then call `worker.execute(invocation_ref, decision)`. The local
host performs this admission automatically. Serialized/forged, foreign-policy,
wrong-principal and non-execution decisions are rejected. A decision is consumed
once and its fence binds one invocation; it cannot fund another attempt. The
worker retains only this clean-host capability, never model-supplied policy data.
`requestPolicyTimeoutMs` bounds each policy recheck (100–30,000 ms; default
30,000); the local host uses its configured `deadlineMs`.

Creation and execution re-read durable disable control after preparation/lease
waits and again through the broker's effect fence after broker-owned waits.
Disabling or disabling/re-enabling at a newer epoch rejects stale execution.
Rechecks consume no additional quota. Destruction, absence verification,
journaling and outcome/recovery bookkeeping do not inherit this execution-only
disable fence. Known pre-effect policy denial therefore permits controller
cleanup of already journaled resources; unknown create/journal outcomes remain
uncertain and require the existing recovery path.

With a configured policy, every successful broker response must have awaited
its effect fence. A missing fence fails closed as an unknown broker outcome;
the same applies to a rejected callback that never completed its required fence.
If a broker starts a fence, it must finish successfully before its response is
accepted even on the optional legacy local-test path. Failed or unfinished
fences and propagated driver-issued invalid-fence errors retain private
uncertainty and stop further callbacks. Classification does not trust provider
error codes. A correctly completed first fence remains valid when a duplicate
call is rejected and handled by the broker; a retained/late call is only a denied
capability, not retroactive cancellation. None of this proves the broker used
the fresh context at the actual effect or that no API call occurred. This capability is for a trusted broker,
not isolation from a compromised host that already owns the provider object.
Separate policy/control-plane reads are **not atomic with a provider effect**.
Their order is lease/credential/binding renewal, then a policy read; credential
revocation can race that policy read. These are ordered pre-effect checks, not
a simultaneous principal/lease/policy snapshot. The worker also cannot prove
whether a trusted callback actually fenced before its API call or honored the
fresh context; arbitrary host callbacks are not qualified broker implementations.
A disable after the final check can still race a dispatched effect; it does not
retroactively erase an effect or skip resource journaling/cleanup. Qualified
effect-edge fencing, in-flight cancellation and independent observation remain
required before production. Omitting policy preserves only the old local-test
path, never production authority.

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

Cleanup attempts known plan entries sequentially and independently. If one
resource's destroy or verification callback fails without private driver
uncertainty, the next resource still receives its own fresh lease, current
credential and provider-binding checks. Lease loss/expiry/takeover, credential
withdrawal, shutdown, binding loss or broker-fence uncertainty stops further
callbacks. A failed resource contributes no accepted absence evidence, and any
callback failure prevents `completeCleanup`: return only the generic redacted
`WORKER_CLEANUP_FAILED` and retain `cleanup_pending`. Shutdown preserves the
existing redacted `WORKER_CLOSED` error instead; it also stops further callbacks
and cannot complete cleanup. Without configured policy, a callback that fails
before starting its optional fence remains a resource-local legacy local-test
failure; with policy, the same missing required fence makes the attempt uncertain.
Neither case grants production broker authority. The verify-only settlement
path also attempts the other observation but never imports a partially verified
result. Full success gets a final current-authority fence before the control
plane independently verifies all evidence and authorizes terminal completion.
There is no same-attempt provider retry or persisted partial evidence. Expiry,
reaping and a fresh worker reconcile the retained obligation using the existing
already-absent broker/provider contract; this does not replay creation/execution
or establish real provider destruction/termination.

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
Closing the journal zeroes all of its key copies, not caller keys or database rows.

### Delivery encryption-key rotation (source/local-test only)

`encryptionKey` and `keyId` identify the one active sealing key. On a clean-host
restart, the optional `retiredDecryptionKeys` is a dense array of at most eight
closed `{ keyId, encryptionKey }` records with unique IDs (including the active
ID) and host-owned 32-byte Buffers. The journal snapshots these keys. The local
host exposes the same array as `deliveryRetiredDecryptionKeys`. Neither interface
loads keys from a request, environment fallback, remote key service or ciphertext.

New deliveries use only the active key. Retained v1 ciphertext is decrypted with
the exact configured key matching its `key_id`; that ID, namespace, worker and
attempt remain authenticated as AAD. Missing/wrong keys and ID substitution fail
closed before delivery. There is no trial-decrypt fallback, re-encryption, row
rewrite, schema change, tombstone removal or original-operation/provider retry.
All current principal, tenant, lease and scope checks still apply to an
unacknowledged packet; a retired encryption key does not retain worker authority.

Retain old decryption keys in approved host secret custody for as long as the
reviewed recovery/restore policy requires the corresponding immutable records.
Do not retire a key merely because `listPending` is empty: acknowledged rows and
backups still use that key, and this journal does not enumerate a complete
retention inventory or prove that retirement is safe. A revoked worker credential
cannot be replaced inside its old claim packet; use the existing expiry/reaper
and fresh cleanup/recovery path rather than impersonating the old identity.
Configuration is restart-owned, not an in-place rotation API. Local tests prove
lost claim/resource-response recovery across key rotation; secret-manager rotation,
database credential rotation, backup restore/PITR and hosted qualification remain
open. This is not a production cryptographic key-management service.

The PostgreSQL delivery factory now attests the exact catalog/migration before
returning; operations reattest inside each transaction. An explicit
`expectedOwner` also checks separate runtime identity, ownership and the exact
least-privilege grant set. Only acknowledgement columns are updateable; namespace
policy and migration evidence are runtime-read-only. Without `expectedOwner`,
the local test checks catalog only. Neither mode qualifies managed hosting or
turns on production. See the dedicated role templates and Gate 4 in
[DEPLOYMENT_GATES.md](./DEPLOYMENT_GATES.md).

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
The driver checks shutdown again after an awaited lease renewal and before each
provider/lookup callback, so closing during that wait cannot dispatch new work.
Cancellation does not prove a provider resource stopped or was destroyed.
Recovery is still mandatory for unfinished durable invocations, and a callback
that never settles requires broker/operator recovery.

## Source evidence versus remaining production work

`test/worker.test.mjs` exercises the real controller with an in-memory provider:
immediate journaling, duplicate callers, no double destroy, lost journal
acknowledgement, both-found/partial/total-absence recovery without execution,
cleanup-attestation denial, operation substitution, expiry after a response,
shutdown, and scope withdrawal after metering.
Cleanup regressions include destroy/observation failure, deceptive provider
error codes, fresh-worker convergence, scope/expiry/binding/shutdown/takeover
loss, missing/failed/unfinished fences and handled duplicate-fence rejection.
Existing
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
