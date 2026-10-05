# Durable policy telemetry (source/local-test only)

This is a bounded observer outbox, not an execution receipt, authority ledger,
hosted monitoring system or production alert service. No endpoint, provider,
database, credential, deployment or paid call is provisioned. All APIs reject
production mode and report `production_qualified: false`.

## Existing policy and host integration

Choose exactly one callback in `createManagedRequestPolicy`:

- `emitTelemetry(event)` is compatibility best-effort emission: one callback at
  a time, a bounded FIFO, explicit failure/overflow counters, no durable guarantee.
- `recordTelemetry(event, { signal })` requires the exact closed response
  `{ event_ref: event.event_ref, persisted: true }`. Admission/execution wait for
  this acknowledgement, bounded by `telemetryTimeoutMs` (100–5,000 ms), then
  recheck current enable/epoch state. Failure/unknown acknowledgement grants no
  decision. Cleanup, recovery, reads and already-denied requests never wait for
  telemetry. Their recording can fail; this is not lossless telemetry under outage.

Pending actual callback work plus queued events is capped at 64. Cancellation
does not free a slot until its callback settles. `telemetryHealth()` exposes
saturating process-local counters; `flushTelemetry()` reports bounded settlement,
not callback termination or durable delivery. Process crashes can lose events
that have not committed. A host must independently monitor failures/overflow.

A durable pre-authorization event is `policy_candidate`, outcome `candidate`:
it does not claim admission, execution or effect success. An epoch change during
append can deny the request while retaining that candidate. Observer data never
supplies a dispatch decision. Existing effect-time fences remain required.

The functions below are checkout-only imports from
`risk-fork/managed-service/src/index.mjs`, not public SDK exports or an installed
hosted service. The public package includes these instructions and role templates,
but not the source-only managed-service runtime entrypoint.

```js
// Owner has separately migrated/provisioned a dedicated telemetry database and
// exact roles. These host-owned values are never request/model-controlled.
const telemetry = await createPostgresManagedTelemetryStore({
  connectionString: hostTelemetryUrl, tls: { ca: hostTelemetryCa },
  schemaName: 'risk_fork_telemetry', expectedOwner: hostTelemetryMigratorRole,
  limits: { maxEvents: 10000, maxEventsPerTenant: 1000,
    leaseMs: 10000, retryMs: 1000, retentionMs: 86400000 },
});
const requestPolicy = createManagedRequestPolicy({
  readControl: (signal) => policyStore.readControl(signal),
  consumeRateLimit: (request) => policyStore.consumeRateLimit(request),
  recordTelemetry: (event, options) => telemetry.append(event, options),
});
const telemetryDrainer = createManagedTelemetryDrainer({
  store: telemetry, deliver: hostReviewedRedactedSink,
  deliveryTimeoutMs: 1000, intervalMs: 1000, maxBatch: 16,
});
// Supply requestPolicy and telemetryDrainer to the explicitly enabled local
// host. It starts polling only after startup, closes ingress/effect capabilities
// before bounded recorder/drainer shutdown, and retains settlement truth in
// health(). The caller closes stores afterward. This is not public TLS hosting.
```

## Independent database and privileges

`migrations/005_managed_telemetry.pg.sql` is version 1 of its own observer ledger,
not policy/control-plane migration 005. Frozen policy/control/delivery migrations
are untouched. Run `migratePostgresManagedTelemetry` as the separately provisioned
owner, then the [dedicated role template](./ops/postgres/telemetry-roles.sql.template).
The migrator rejects runtime-only `expectedOwner`, and reports runtime privilege
assurance false. The store must supply it to attest a distinct least-privilege
runtime. Never use shared migrators or grant these privileges in another ledger.

Factory-created pools require pinned-CA TLS. Injected non-TLS pools require an
explicit disposable local database. PostgreSQL 16 and synchronous durability are
required. Runtime verifies the source-owned full catalog, migration/settings hash,
and optional exact owner/role/ACL binding before writes and again after the shared
clock lock. DB time cannot regress. Owner DDL/ACL maintenance requires draining;
attestation is not protection from concurrent owner compromise.

Runtime gets SELECT, payload-column INSERT, clock-column UPDATE and delivery-
metadata UPDATE only: no payload UPDATE, DELETE, TRUNCATE, settings/ledger writes,
DDL or grant authority. A stolen runtime credential can forge observer inserts or
delivery metadata; this trusted-host outbox is not hostile-host assurance.

## Replay, leases, retention and limits

Closed events contain only a 24-byte random event reference, fixed labels/status,
bounded duration and domain-separated tenant/key hashes. No raw principal,
bearer, lease token, request arguments, provider payload, DSN or error text is
stored. One constructed packet retains its reference across exact append and
delivery replay. Creating another policy attempt creates another event; this is
not cross-request exactly-once telemetry. A host needing append retries must retain
and replay the exact packet rather than generate another reference.

Append is duplicate-first. A same-reference payload mismatch fails. Global and
tenant limits count every row, including acknowledged tombstones, and serialize
across instances. Unknown/late commits do not return success; exact replay
converges if committed. There are no automatic SQL or original-operation retries.

Claims have random token hashes, DB-time expiry, generation and attempts. An exact
active claim replay neither extends its lease nor increments attempts. New
claimants recover expired rows; stale acknowledgements/retries cannot change a
new generation. Exact committed acknowledgements replay without redelivery.
Delivery is **at least once**: the sink must deduplicate `event_ref`. Its only
accepted reply is `{ event_ref, delivered: true }`. Lost sink/ack responses can
cause later same-event redelivery; no exactly-once delivery claim is made.

One drainer bounds actual sink overlap. Timeout/close preserves the claim and
does not acknowledge or immediately release/retry it. A hung callback ignoring
abort remains visible and blocks further local sends; another instance may
recover after lease expiry. Cancellation is not remote termination. Rejected
replies/errors persist only a closed redacted retry code and DB-time backoff.
Health counts intentional shutdown as `shutdown_interrupted`, separately from
delivery-deadline `timed_out`; neither counter proves callback termination.

Awaited candidate recording, delivery, flush and close deadlines own referenced
timers until their wait settles or expires. They work even when Node has no
other active handles, and dispose timers/parent-abort listeners on settlement.
Idle polling and nonblocking cleanup/recovery/denial recording do not retain the
process. Underlying callback slots remain occupied until actual settlement:
expiry never manufactures delivery, callback termination or an immediate retry.

Attempt/generation exhaustion leaves unresolved rows visible via `stats().exhausted`,
consuming capacity for owner intervention but not blocking other claimable events.
No automatic deletion of unresolved events occurs. Explicit owner-only
`prunePostgresManagedTelemetry({ ..., expectedOwner, maxDelete })` removes at most
1,000 acknowledged events older than the configured retention. Pending/claimed
rows are retained. Retention is 1 second–7 days; capacity is at most 1,000,000 rows,
not a measured byte, throughput or managed-storage cost guarantee.

## Evidence and remaining Gate 5 work

Focused deterministic tests and guarded real PostgreSQL tests cover capacity,
replay/restart, unknown/late commits, stale claims, roles, retention, drift, abort,
backoff and factory TLS positive/wrong-CA rejection. CI supplies disposable PG16
and CA TLS on Node 20/22/24. Standalone subprocess tests exercise hung deadlines
without test-only keep-alive timers, late settlement/no acknowledgement, idle
process exit and listener disposal. Local tests cannot establish hosted sink custody,
monitoring SLOs, HA/restore/rotation, WAF, real alert delivery or an observed
operator response drill. Budget/lease/provider/cleanup/audit/DB event wiring and
threshold/alert rules remain separate work. No provider or live agent traffic is
protected by this tranche. See [OPERATIONAL_QUALIFICATION.md](./OPERATIONAL_QUALIFICATION.md).
