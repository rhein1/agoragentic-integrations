# Durable policy, lifecycle and metric telemetry (source/local-test only)

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
  deliveryTimeoutMs: 1000, storeTimeoutMs: 1000, intervalMs: 1000, maxBatch: 16,
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

The v1/v2 runtime gets SELECT, payload-column INSERT, clock-column UPDATE and
delivery-metadata UPDATE only: no source payload UPDATE, DELETE, TRUNCATE,
settings/ledger writes, DDL or grant authority. Opt-in v3 additionally grants
metric-window payload/hash and aggregate-total UPDATE, never source/alert payload
UPDATE. A stolen runtime credential can forge observer inserts or
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

One drainer bounds actual sink and store overlap. Each `claim`, `acknowledge`
and `retry` wait has its own `storeTimeoutMs` (50–5,000 ms, defaulting to
`deliveryTimeoutMs`), with an owned abort signal and referenced timer. This is
a per-operation bound, not a total batch-duration or database termination bound.
The drainer captures the original store methods with their receiver; later
mutation of composition options or methods cannot replace them.

Timeout/close preserves unknown claims/commits and does not acknowledge or
immediately release/retry them. A callback ignoring abort remains visible and
blocks new local work until its actual settlement; another instance may recover
after lease expiry. Late store responses only clear their pending slot: a late
claim cannot deliver, a late acknowledgement cannot increment `delivered`, and
a late retry cannot trigger another attempt. Store cancellation does not prove
query cancellation, non-commit or remote termination. Rejected replies/errors
persist only a closed redacted retry code and DB-time backoff.

Health preserves sink-specific `in_flight`, delivery-deadline `timed_out` and
intentional sink shutdown `shutdown_interrupted`. Store waits separately expose
`store_in_flight`, `store_timed_out` and `store_shutdown_interrupted`; an actual
store rejection or deadline increments `failed` once, while shutdown does not.
These are saturating process-local counters, not durable unique-event metrics.
`close().settled` includes both actual store and sink work; neither a bounded
result nor these counters prove termination or a successful durable commit.

Awaited candidate recording, store operations, delivery, flush and close deadlines own referenced
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

## Opt-in lifecycle observer

`createManagedLifecycleObserver` reads the existing tenant-authenticated
bounded invocation pages and audit windows, without calling any worker or
provider method. This is checkout-only source composition, not hosted access.
Each read uses the original immutable `audit:read` principal and repeats current
credential authorization. The host supplies 1–64 distinct-tenant principals,
a stable `observerId`, cadence, deadline and 1–64 tenants per tick.

Enable `lifecycle:true` explicitly for migration and every store using the v2
schema, including a policy store with `eventKind:'policy'`. Default v1 stores
continue rejecting an unreviewed v2 catalog; there is no silent upgrade. Drain
old stores first. The owner migrator attests the complete frozen v1 catalog,
ledger and settings before applying additive migration `006_managed_lifecycle`.
It preserves `005`, policy rows and labels. Apply the existing
[role template](./ops/postgres/telemetry-roles.sql.template) after migration,
then [lifecycle grants](./ops/postgres/lifecycle-grants.sql.template).
Both versioned hashes and the complete v2 catalog are checked on every operation;
`expectedOwner` remains required for distinct runtime-role assurance.

```js
// All values and prior migration/role setup are trusted host configuration.
const lifecycleStore = await createPostgresManagedTelemetryStore({
  ...hostTelemetryOptions, lifecycle: true, eventKind: 'lifecycle',
});
const lifecycleObserver = createManagedLifecycleObserver({
  controlPlane, store: lifecycleStore, auditPrincipals: hostAuditPrincipals,
  observerId: 'host-lifecycle-v1', timeoutMs: 2000,
  intervalMs: 1000, maxTenantsPerTick: 4,
});
const lifecycleDrainer = createManagedTelemetryDrainer({
  store: lifecycleStore, eventKind: 'lifecycle', deliver: hostReviewedRedactedSink,
});
// Supply these original objects to the enabled local host alongside any policy
// recorder/drainer. The host closes ingress/effect capabilities, stops/flushes
// the lifecycle observer, then closes drainers. Close stores afterward.
```

Store/drainer/source pairing is the trusted host's responsibility. Observer
options, IDs, principals, source/checkpoint cursors and sink callbacks are never
request/model-controlled. The host retains original branded observer/drainer
objects and does not reread mutable composition options.

One tenant step visits one invocation and at most 64 next source events. The
transaction verifies the original finite sweep bound and per-invocation source
prefix, inserts deterministic redacted observations **before** advancing the
prefix and sweep in the same commit. All observer transactions serialize through
the existing telemetry clock lock; they acquire no authoritative writer lock.
Unknown commits return no success. Exact retained batch replay confirms the
single advancement even after acknowledged rows were pruned. Stale/conflicting
writers fail closed and reread on a later tick; no original operation is retried.

A finite sweep resets its cursor and upper bound. New references above or below
the old cursor, and later audit appends, are discovered in subsequent cycles.
A busy invocation's backlog drains over later cycles, allowing other invocations
to progress. Cycle completion means each invocation in that pinned interval was
visited once, **not** that all historical source events were delivered.
Different tenants rotate fairly. A callback ignoring abort keeps its tenant's
slot until actual settlement; other tenants can continue. Every await checks
closure/abort before a later source read or append. Close reports `settled:false`
when work remains; timeout is not callback/DB termination proof.

Lifecycle observations use the fixed `control_plane_audit_observed` envelope,
`control_plane_self_attested` evidence, known current source labels, canonical
time, sequence and domain-separated tenant/invocation/source hashes. Unknown
future labels stop projection pending review. No raw details, tokens, operations,
provider/resource IDs or raw invocation references are exported. A source
`execution_outcome_recorded` or `cleanup_verified` label is not independent
effect, cleanup or provider-success evidence. Audit details are unavailable, so
this producer does not reconstruct historical costs, budget pressure, actual
lease deadlines, provider error details or isolation guarantees.

Per-invocation prefix rows are permanent. Owner retention removes acknowledged
lifecycle events only, never checkpoints/sweeps or unresolved delivery rows.
A retained per-sweep prefix count detects checkpoint deletion after pruning;
scope-bound state hashes detect row corruption. This is trusted-host custody,
not tamper-proof evidence against a schema owner rewriting all observer state.
Use one stable configured observer identity across instances/restarts. Changing
it is owner-managed reprojection and can redeliver old deterministic IDs after
retention; the sink still must deduplicate IDs. It is not a reset/repair procedure.

Policy and lifecycle outboxes each have the configured `maxEvents` and
`maxEventsPerTenant` caps; enabling both can retain their sum. Permanent prefix
rows have the same global/per-tenant lifetime caps across observer identities,
and sweep rows have the global cap. Exhaustion fails closed rather than pruning
history or silently restarting at genesis. The owner must monitor capacity and
plan a separately reviewed custody migration. These are row-count ceilings,
not measured byte, throughput or storage-cost guarantees.

## Opt-in metric counts and threshold alert outbox

This extends the **existing observer schema**, not the authority ledger or a new
runtime. Set `lifecycle:true`, `metrics:true` and explicit `metricSettings` on the
owner migration and **every** store sharing the v3 schema. Defaults remain v1;
v2/v1 callers reject a v3 catalog. Drain old runtimes before upgrading. Additive
`007_managed_metrics_alerts` preserves frozen `005`/`006`. Apply the existing
telemetry and lifecycle role templates, then the
[v3 metric grants](./ops/postgres/metrics-grants.sql.template). Supply
`expectedOwner` for distinct least-privilege runtime assurance; catalog-only
initialization is not role qualification.

Rules count accepted, committed observer packets by tenant and DB **ingestion**
time, not the source event's occurrence time or all real traffic:

| Rule | Exact recorded evidence | Not established |
| --- | --- | --- |
| `rate_denied` | policy rate rejection | budget pressure or expenditure |
| `control_disabled` | intentional policy disable rejection | dependency failure |
| `control_failed` | failed-closed control rejection | the root cause of failure |
| `policy_timeout` | recorded policy timeout | remote cancellation/termination |
| `policy_failure` | recorded failed-closed policy error | typed DB/provider/audit failure |
| `lease_expiry_observed` | execution/cleanup/recovery `*_lease_expired` audit label | actual lease age, backlog size, provider destruction |

Unknown rules, request-supplied formulas, duplicate rule IDs and accessor fields
are rejected. Configure 1–6 rules, each with threshold 1–1,000,000 and fixed
window 1,000–86,400,000 ms. Rules are canonically sorted and immutable settings
and all three migration/catalog hashes must match. Changing thresholds or
capacities is a separately reviewed migration, not a hot reload.

```js
// Trusted checkout-only composition, not an npm-installed managed runtime.
const metricSettings = {
  maxSources: 10000, maxSourcesPerTenant: 1000,
  maxWindows: 1000, maxWindowsPerTenant: 100,
  maxAlerts: 1000, maxAlertsPerTenant: 100,
  rules: [
    { rule_id: 'rate_denied', threshold: 10, window_ms: 60000 },
    { rule_id: 'lease_expiry_observed', threshold: 1, window_ms: 60000 },
  ],
};
const metricsOptions = {
  ...hostTelemetryOptions, lifecycle: true, metrics: true, metricSettings,
};
const policyStore = await createPostgresManagedTelemetryStore(metricsOptions);
const lifecycleStore = await createPostgresManagedTelemetryStore({
  ...metricsOptions, eventKind: 'lifecycle',
});
const alertStore = await createPostgresManagedTelemetryStore({
  ...metricsOptions, eventKind: 'alert',
});
const alertDrainer = createManagedTelemetryDrainer({
  store: alertStore, eventKind: 'alert', deliver: hostReviewedRedactedAlertSink,
  deliveryTimeoutMs: 1000, storeTimeoutMs: 1000, maxBatch: 16,
});
// Bind policy/lifecycle recorders to the corresponding original stores. Supply
// alertDrainer to the explicitly enabled local host; it schedules only after
// startup and closes after ingress/effect capabilities and source recorders.
// Close all stores afterwards. No sink, credentials or network calls are built.
```

One clock-serialized transaction inserts the original policy/lifecycle source,
updates fixed-window counts, creates at most one threshold alert and records
permanent exact-source custody. Lifecycle checkpoints advance in that same
commit. A failure rolls back all parts. Concurrent/exact replay matches the
original source identity/hash and retained contributions without double-counting;
retained lifecycle-batch replay also verifies metric custody. Different policy
attempts have different random IDs and can count separately. This is not
cross-request exactly-once telemetry.

The aggregate hash covers **source/window row counts**, not their identities or
complete contents. Initialization and `stats()` check catalog/settings, totals
and retained window/alert relationships; they do not authenticate every custody
row. Exact append/batch replay validates its source packet and contributions,
and touched/read windows and delivered alerts validate their closed payloads and
hashes. Same-count source replacement or a window hash change can pass aggregate
health until that row is exercised. A schema owner or stolen runtime credential
capable of consistently forging observer state is not defeated by these hashes.
They are trusted-host replay/corruption checks, not signed independent evidence
or a global tamper-proof audit. Observer health never authorizes execution.

At `count === threshold`, one deterministic alert ID binds tenant, rule, window
and rules hash. Further packets in that window increase count without emitting
another alert. Adjacent windows can each emit an alert: there is **no global
cooldown, hysteresis or severity-escalation policy**. The closed alert includes
hash-only identity, rule/window/threshold/count, `ingested_observations_only`
coverage, source-specific self-attestation and `production_qualified:false`.
It grants no authority and contains no raw arguments, errors or credentials.

Delivery reuses the original bounded at-least-once drainer, lease/generation
fences and retry codes. The host sink must deduplicate `event_ref`. A committed
alert ACK records its exact existing acknowledgement hash/time in the permanent
window **atomically** with the outbox ACK. Missing pending alerts, orphan alerts,
altered alert packets and inconsistent retained ACKs fail closed. Owner retention
can prune only old acknowledged delivery rows. Exact replay after legitimate
pruning does not recreate an event or alert. No integrity failure self-repairs.

Upgrade baselines every surviving v1/v2 policy and lifecycle delivery row as
`legacy_uncounted`, preserving its exact identity/hash and validating stored
lifecycle metadata. It creates no historical windows or alerts. Already-pruned
history is unavailable and is not reconstructed. A later new source projection
of that unavailable history is a new ingestion, not complete historical metrics.
Upgrade rolls back if retained history exceeds the explicit custody cap; plan
capacity for the combined surviving policy/lifecycle rows first.

`readMetrics({tenant_hash,signal})` is a trusted checkout-only read, not an HTTP
endpoint, authentication decision or receipt. It returns the latest 64 validated
windows, a truthful `truncated` flag and retained/legacy source counts. It is not
a complete history, cursor or sink-delivery proof. The host owns tenant access.

Each global and tenant source/window/alert cap is 1–1,000,000. Source custody,
windows and aggregate totals are **lifetime retained**, not periodically pruned.
ACK pruning frees delivery capacity only. At lifetime capacity new observations
fail closed; exact retained replay remains possible. Monitor both row count and
drift, and plan a separately reviewed custody migration. Deleting custody,
starting a replacement schema or changing observer IDs is not a safe automatic
reset. These ceilings do not promise sustained operation, bytes, cost or scale.
Integrity verification scans retained state on each transaction under bounded
SQL waits; maximum-capacity throughput/SLOs and safe long-term custody management
require separate operational measurement and qualification.

## Evidence and remaining Gate 5 work

Focused deterministic tests and guarded real PostgreSQL tests cover capacity,
replay/restart, unknown/late commits, stale claims, roles, retention, drift, abort,
backoff and factory TLS positive/wrong-CA rejection. CI supplies disposable PG16
and CA TLS on Node 20/22/24. Standalone subprocess tests exercise hung deadlines
without test-only keep-alive timers, late settlement/no acknowledgement, idle
process exit and listener disposal. Local tests cannot establish hosted sink custody,
monitoring SLOs, HA/restore/rotation, WAF, real alert delivery or an observed
operator response drill. Opt-in v3 adds source-count thresholds and an alert
outbox, not a hosted alert service. Accurate historical budget/cost/lease
measurements, cleanup backlog/failure, typed dependency/provider/audit/DB-failure
events, broader cooldown policy, hosted sink custody and an observed
alert/response drill remain separate work. No provider or live agent traffic is
protected by this tranche. See [OPERATIONAL_QUALIFICATION.md](./OPERATIONAL_QUALIFICATION.md).

### Cancellation observer compatibility

The closed lifecycle vocabulary includes the actual `cancellation_requested`
label emitted by both control-plane stores. Earlier observer source rejected
this label and could repeatedly stop before advancing a canceled invocation's
prefix/sweep. Upgrade the observer/projector and drainer together. No database
migration, catalog recapture or grant change is needed: frozen v2/v3 lifecycle
payload storage does not constrain the source label in SQL.

This is an observation of a cancellation request, not cancellation completion,
provider termination, verified resource absence, actual spend or cleanup backlog.
Its original deterministic ID, redaction, prefix custody and at-least-once
delivery contract are unchanged. The six existing metric rules do not count it
or emit a new alert. Disposable tests cover the real PostgreSQL cancellation
writer with v2/v3 projection, lost-COMMIT replay, restart, acknowledged retention
and later sweep progress; local success is not hosted sink/provider proof.
