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
are rejected. Configure 1–6 rules in v3 (up to 7 in opt-in v4, 8 in opt-in v5, 10 in opt-in v6 or 11 in opt-in v7), each with threshold 1–1,000,000 and fixed
window 1,000–86,400,000 ms. Rules are canonically sorted and immutable settings
and every migration/catalog hash for the selected version must match. Changing thresholds or
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
measurements, durable cleanup backlog, safe typed dependency/provider/audit/DB-failure
root-cause events, broader cooldown policy, hosted sink custody and an observed
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

### Opt-in v4 failed execution observations

`execution_failure_observed` counts only an explicit failed execution outcome
accepted and committed by the control plane. Both memory and PostgreSQL stores
emit this new audit label for `outcome:'failed'`; successful outcomes keep
`execution_outcome_recorded`. This is `control_plane_self_attested` evidence,
not independent provider-failure diagnosis, cancellation/termination, verified
cleanup, cost, or live protection. Historical `execution_outcome_recorded`
events are never reclassified from hidden audit details. Cancellation, cleanup
and other lifecycle labels do not match the new rule.

Enable `metricVersion:4`, `lifecycle:true` and `metrics:true` on the owner
migration and **every** store sharing the schema. Include the new fixed rule in
the trusted `metricSettings.rules` array, for example
`{ rule_id:'execution_failure_observed', threshold:1, window_ms:60000 }`.
Omitting `metricVersion` still selects v3 and rejects this rule. V4 adds
`009_managed_execution_metrics.pg.sql` as version **4 of the telemetry ledger**;
`008` belongs to the independent control-plane ledger. Frozen `005`/`006`/`007`
are unchanged. The PG16 v4 catalog is separately captured with
`node managed-service/scripts/capture-metrics-catalog.mjs --v4` against an
explicitly disposable database. No tables, columns or additional runtime grants
are introduced; the existing telemetry/lifecycle/metrics role templates apply.

Fresh schemas and v1/v2 upgrades may select the new rule. Surviving v1/v2 rows
remain `legacy_uncounted`, including historical failed outcomes with the old
label. A v3 schema may upgrade to v4 **only with identical persisted metric
settings**; that catalog-only upgrade does not enable the new rule. Adding it
to existing v3 settings fails before DDL/custody changes, even for an empty
schema. Settings hashes bind retained sources, windows and alert acknowledgements:
never clear custody, rewrite hashes, or reproject history to bypass this check.
Provision a separately reviewed fresh v4 observer schema, or design a separate
versioned rule-set custody migration; this tranche does not provide the latter.

Drain old metric runtimes before a schema upgrade: v3 stores reject a v4 catalog.
Upgrade the lifecycle observer/projector **before** enabling new writers: old
observer source rejects the new audit label. Earlier v2 observers using current
source can project it without counting it; only v4 metrics enable the new rule.
Alert schema, redaction, deterministic identity, source custody, ACK/pruning,
ingestion-time windows, capacity bounds, `ingested_observations_only` coverage
and `production_qualified:false` are unchanged. Disposable PG16/TLS tests cover
actual failed/successful PostgreSQL producers, multi-instance exact replay,
lost COMMIT/ACK, pruning, rollback/caps, migration compatibility, least-privilege
roles and catalog drift. These are source/local-test evidence, not hosted alert
delivery, provider qualification or production activation.

### Opt-in v5 HTTP budget-denial observations

Set trusted `observeBudgetDenials:true` on `createManagedRequestPolicy` to
observe authenticated **public HTTP** admission failures after the actual
control-plane/store promise rejects. The local host uses the same public
handler. Direct `controlPlane.admitInvocation()` and direct store calls remain
unobserved. Omitting the option preserves the previous producer behavior.

Only exact typed `INVOCATION_BUDGET_EXCEEDED` or `DAILY_BUDGET_EXCEEDED` errors
with status 429 produce `invocation_budget_denied` or `daily_budget_denied`,
respectively, with fixed `budget_limited` outcome and `admission` route. Rate
limits, concurrency quota, validation/authentication, policy disablement,
recovery fences and idempotency errors do not match. Global protocol/config
input ceilings still reject invalid inputs as before; they are not reclassified
as typed tenant budget denials. Accepted/replayed admissions and cost settlement
do not emit this event. No budget/reservation/authority behavior is changed.

The handler retains its original policy decision and calls the original branded
policy's `observeAdmissionDenial(decision,error)` method only after admission
rejects. The decision is instance-bound and one-use for observation. `true`
means an observation was attempted, **not** durable persistence or authority.
The existing bounded recorder constructs one packet and keeps its reference
through append/delivery. It is nonblocking: queue overflow, sink rejection,
timeout, unknown commit or a callback ignoring abort cannot replace or delay
the original error response. Health/flush preserve actual callback settlement;
this remains lossy under outage/process loss and is not a complete rejection
ledger. Nothing raw from the error/body, including amounts or budget balances,
is recorded. Hashes and fixed labels are `host_policy_self_attested` observer
evidence, not actual spend or independent provider evidence.

For durable recording/counts select `metricVersion:5`, `lifecycle:true`,
`metrics:true` and explicit immutable `metricSettings` on migration and **every**
store sharing the schema. Configure `{rule_id:'budget_denied',threshold:1,
window_ms:60000}` as a trusted example, not qualified production sizing. The
rule counts both exact budget-denial labels by DB ingestion time. Other rules
keep their prior semantics. V1–v4 stores reject these packets/catalogs; upgrade
the recorder, drainer and store before opting the HTTP producer in.

The callback-based policy cannot inspect a recorder's schema version at
composition time. An opt-in policy paired with a v3/v4 durable recorder can
still admit its supported policy candidate, but the later budget append is
rejected: `telemetryHealth().failed` increases, no budget packet/count persists,
and the original 429 response is unchanged. `observeAdmissionDenial() === true`
does not establish compatible or durable storage. Test the v5 recorder setup
before enabling the observer; do not interpret callback acceptance as coverage.

Additive `010_managed_budget_metrics.pg.sql` is version **5 of the independent
telemetry ledger**, after frozen `005`/`006`/`007`/`009`. It widens only the
ledger-version, metric-rule, policy-event and exact policy-label CHECKs. No
tables, columns or grants are added; the existing dedicated telemetry,
lifecycle and metric role templates apply. Capture the independent PG16 v5
catalog with `node managed-service/scripts/capture-metrics-catalog.mjs --v5`
only in the explicitly disposable loopback lab.

Fresh schemas and v1/v2 upgrades can bind the new rule; surviving old packets
remain `legacy_uncounted`, never retroactively counted. Existing v3/v4 schemas
can upgrade catalog-only **with identical persisted metric settings**. Adding
the new rule to those settings fails before DDL/custody changes even if empty.
Do not erase custody, reset history or rewrite hashes. Enabling a new rule needs
a separately reviewed fresh observer schema/coverage boundary or a separate
versioned rule-set custody migration, not a hot reload. Drain old runtimes
before upgrading; rollback means disabling the new observer while preserving
custody, not a down migration or destructive reset.

Threshold alerts retain deterministic IDs, exact-source replay, atomic ACK
custody, at-least-once delivery, permanent capacity limits,
`ingested_observations_only` coverage and `production_qualified:false`.
Disposable PostgreSQL/TLS/role tests are local evidence only; hosted sinks,
operator alert drills, accurate balances/expenditure, managed operations and
activation remain open.

### Opt-in v6 terminal cleanup and recovery verification observations

Two distinct lifecycle rules count only the exact committed audit labels:
`cleanup_verified` and `recovery_absence_verified`. The control plane already
emits the first after all recorded-resource cleanup evidence and the exact
provider binding's verifier succeed; it emits the second after fresh,
exact-bound total-absence evidence and its recovery verifier succeed. Failed,
stale, incomplete or rejected evidence cannot emit either verification label.
No producer, provider callback, control-plane transition or authority is added.

The authenticated `audit:read` lifecycle observer projects these labels without
raw details, resource IDs, invocation references, errors or original arguments.
Counts remain by DB ingestion time, with `control_plane_self_attested` evidence,
`ingested_observations_only` coverage and `production_qualified:false`. A count
does not establish independent provider deletion, exhaustive resource search,
cleanup backlog/failure, callback termination, actual spend or live protection.
Unknown cleanup and rejected attestations remain unresolved, never successes.

Select `metricVersion:6`, `lifecycle:true`, `metrics:true` and explicit trusted
`metricSettings` on migration and every store sharing the schema. For example:

```js
const rules = [
  { rule_id: 'cleanup_verified', threshold: 1, window_ms: 60000 },
  { rule_id: 'recovery_absence_verified', threshold: 1, window_ms: 60000 },
]; // Example thresholds only, not qualified production alert sizing.
```

Additive `011_managed_cleanup_metrics.pg.sql` is version **6 of the independent
telemetry ledger**. Frozen `005`/`006`/`007`/`009`/`010` remain unchanged. Only
the ledger-version and metric-window rule CHECKs widen; no tables, columns,
grants, policy packets or authority change. Capture the separate PG16 v6
catalog with `node managed-service/scripts/capture-metrics-catalog.mjs --v6`
only in the explicitly disposable lab. Existing telemetry/lifecycle/metric
role templates still apply.

Fresh schemas and v1/v2 upgrades may select these rules; surviving old packets
remain `legacy_uncounted`. Existing v3/v4/v5 schemas may upgrade catalog-only
with identical persisted metric settings. Adding either rule to those settings
fails before DDL/custody mutation, even if empty. Enabling new rules therefore
requires a separately reviewed fresh observer schema/coverage boundary or a
future versioned settings-custody migration, not hash rewriting or a reset.
Drain old runtimes before upgrading: v1–v5 stores reject the v6 catalog.
Earlier current-source lifecycle observers can project these existing labels
without counting them. Pair every store/drainer with the selected version.

Exact-source replay, atomic source/window/alert/checkpoint commits, immutable
settings, ACK/pruning custody, at-least-once delivery and global/tenant lifetime
caps remain unchanged. Disposable PG16/TLS/role tests are local source evidence,
not deployed sink delivery, a provider qualification receipt, an operator
response drill or production activation. Typed failure/backlog/dependency/DB
health metrics and hosted qualification remain separate work.

### Opt-in v7 incomplete cleanup attempts

`cleanup_incomplete_observed` counts only the exact `cleanup_incomplete` audit
label committed through the current-authority, active-cleanup-lease-bound
[incomplete-attempt producer](./WORKER.md). That producer retains one event per
cleanup lease generation; exact replay does not create another attempt. A new
generation can emit a new event even for the same unresolved invocation. Counts
are incomplete **attempt observations**, not unique unresolved invocations,
current backlog, provider failures, root cause or eventual outcome.

Select `metricVersion:7`, `lifecycle:true`, `metrics:true` and explicit trusted
`metricSettings` on migration and every store sharing the schema. Configure,
for example, `{rule_id:'cleanup_incomplete_observed',threshold:1,window_ms:60000}`.
Example sizing is not a qualified production alert policy. Default metrics stay
v3; v3–v6 reject this rule. Earlier rules retain their exact meanings. The
`cleanup_verified`/`recovery_absence_verified` rules still require v6 or later;
none of those labels counts as an incomplete attempt, and provider text or
unknown labels can never be used as an alternative source.

Additive `012_managed_cleanup_incomplete_metrics.pg.sql` is version **7 of the
independent telemetry ledger**. Frozen `005`/`006`/`007`/`009`/`010`/`011` and
their v1–v6 catalogs remain unchanged. Only ledger-version and metric-window
rule CHECKs widen; there are no new tables, columns, grants, authority,
receipts or provider calls. Capture the separate v7 catalog with
`node managed-service/scripts/capture-metrics-catalog.mjs --v7` only against the
explicitly disposable PG16 loopback lab. Existing role templates still apply;
`expectedOwner` is required for distinct runtime privilege assurance.

Fresh v7 schemas and v1/v2 upgrades can bind the new rule. Historical retained
v1/v2 `cleanup_incomplete` packets remain `legacy_uncounted`: no counters or
alerts are backfilled. Existing v3–v6 schemas may upgrade catalog-only **with
identical persisted settings**. Adding the new rule to those settings fails
before DDL/custody mutation, even if empty. Such a catalog-only upgrade does
not enable incomplete-attempt counting. Enable new rules only with a separately
reviewed fresh observer schema/coverage boundary or a future versioned
settings-custody migration; never erase custody, rewrite hashes or silently
reproject unavailable history. Drain old runtimes before upgrading: they reject
the v7 catalog. Rollback disables new observation while preserving custody,
not a down migration or destructive reset.

The existing authenticated lifecycle observer projects redacted audit labels,
then atomically advances its checkpoint with exact-source custody, ingestion-
time windows and at most one deterministic threshold alert per rule/window.
Concurrent/lost-response/restart replay does not double-count. Original lifetime
global/tenant caps, ACK/pruning proof and bounded at-least-once drainer remain;
external consumers must deduplicate event_ref. Source occurrence times are not
metric-window clocks. Recorded attempts lost before audit commit or observer
ingestion are not manufactured, and telemetry outage is not diagnosed from a
missing event. No new cooldown/hysteresis policy is implied.

Alerts retain `control_plane_self_attested`, `ingested_observations_only` and
`production_qualified:false`. Neither an incomplete alert nor a later verified
label independently proves resource absence, callback termination, isolation,
finalized cost, delivered external alert or live protection. The read-only
current-obligation health snapshot is separate and is not a durable alert source.
Actual disposable producer/observer/restart, replay/capacity/custody and PG16
pinned-CA/restricted-role tests remain source/local evidence. Real external sink
custody/delivery and response drill, durable backlog and safe typed dependency
failure classes, hosted qualification and activation remain separate gates.

### Tenant-authenticated cleanup/recovery snapshot source

`controlPlane.readCleanupRecoveryBacklog(originalAuditPrincipal)` is a trusted,
checkout-only source read, not a public or worker HTTP route. It requires the
original branded `audit:read` principal, revalidates current persisted authority
before the read and again after source/pool waits, and verifies the returned
closed tenant-bound snapshot. The tenant is derived only from that principal;
there is no request-supplied tenant, clock, count, provider or formula. Suspended
tenants and disabled provider bindings do not conceal existing obligations.
Existing config/default-off behavior and minimal public `/readyz` are unchanged.

Both stores report five **current-state gauges**: `cleanup_pending_count`,
`recovery_required_count` and expired execution/cleanup/recovery lease counts.
Cleanup and recovery counts include obligations without an active lease. Lease
expiry is inclusive (`expires_at <= snapshot_at`); reaping is not performed.
The memory backend captures one trusted clock after its exclusive wait. PG16
uses a bounded read-only repeatable-read transaction and one materialized DB
clock for its tenant-filtered aggregate and persisted credential predicate.
Every read is its own consistent MVCC/in-process view, not a cross-read frozen
snapshot or proof of provider resource presence/absence.

The closed response includes canonical `snapshot_at`, tenant identity, the five
safe-integer counts, a domain-separated content hash,
`evidence_class:'control_plane_self_attested'` and `production_qualified:false`.
It exposes no operations, raw invocation/resource refs, provider recovery keys,
lease tokens, credential hashes or errors. Invalid/missing/unsafe counts, wrong
tenant/hash, unavailable source, failed DB reads and inactive credentials throw;
they never manufacture a zero backlog. The content hash is not a signature,
receipt, execution authority, permanent cursor or hostile-host tamper proof.
An exact same-time/state read can have the same hash; no historical custody or
exactly-once observation is implied.

This source reads existing durable invocation state without changing budgets,
leases, audit anchors or resources. No migration, catalog or grant change is
needed; the existing control-plane runtime SELECT boundary applies. This is
the source prerequisite for durable gauge/alert ingestion, **not that ingestion
itself**: v1–v7 telemetry stores/drainers still reject this snapshot as an event,
the lifecycle observer does not poll it, and no external alert delivery or
operator response is established. Durable snapshot custody/gauge thresholds,
safe typed dependency failure classes and production qualification remain open.
