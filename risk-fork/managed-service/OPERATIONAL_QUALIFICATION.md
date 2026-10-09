# Operational qualification packet (not a pass receipt)

This is a source-only runbook. Nothing here provisions a database, creates an
E2B sandbox, installs credentials, deploys a gateway, or enables live traffic.
All production gates in [DEPLOYMENT_GATES.md](./DEPLOYMENT_GATES.md) remain open
until retained evidence from the exact hosted candidate establishes them.

## Production-entry gate: implementation and approval prerequisites

Before any production-entry request, record the concrete remaining source
gaps. The reviewed production qualification class is not implemented, the
managed-service production configuration/activation path remains fail-closed,
and provider qualification evidence is not interchangeable with local-test
evidence. Do not describe a source merge or passing local suite as completion
of these production requirements.

For any controlled qualification call, first bind the exact provider SDK,
runtime/template, adapter, account/project and approved qualification
environment. Before the first call, retain a current exact owner grant, an
owner-approved total ceiling and a hard enforceable cap covering lifetime,
concurrency, retries, teardown, delayed and finalized charges. Establish the
approved synthetic workload and independent privilege-separated pinned-observer
boundary. A payment card, alert, estimate or provider-free test is not cap proof.
If these pre-call prerequisites cannot be established, do not allocate.

The controlled run may produce provisional evidence: isolation, cleanup,
absence, latency and finalized provider cost are collected during or after
the run. Production qualification and live protection remain false until
that exact-bound per-run evidence is independently observed, signed and
verified. Unknown cleanup or unfinalized cost is not a successful qualification.

Use separate approvals and evidence packets for each operational step:

1. authorize the exact qualification run, environment, provider account,
   credential custody, roles, run limit, total ceiling and expiry;
2. qualify provider calls with the pinned adapter and independent observer,
   including isolation, TTL, teardown, verified absence, latency and finalized
   cost;
3. provision and qualify managed resources, migrations, TLS and secret-manager
   custody with separate owner, migrator, runtime, worker and observer roles;
4. approve publication of the exact versioned artifact, SBOM, signatures and
   provenance;
5. approve deployment to default-off staging with no live agent traffic and
   complete hosted multi-instance conformance;
6. approve a narrow enrolled-tenant canary with an immediate kill switch,
   out-of-band cleanup/absence verification, finalized cost and rollback
   evidence; and
7. conduct an independent activation review before any production enrollment
   or traffic expansion.

The historical card/$5 ceiling is context only. It is not a blanket grant for
the current run, provider account, credential, environment or expiry, and it
does not prove that the whole qualification sequence can be completed within
$5. A fresh approval must state the current enforceable ceiling and scope; do
not invent a pricing estimate or provider guarantee.

## Common evidence boundary

Record the commit/tree, locked dependency and runtime digests, provider adapter
digest, schema/migration hashes, environment identifier, test UTC timestamps,
operator authorization and observations. Keep private endpoints, account IDs,
tokens, connection strings, wallet material and keys in an access-controlled
operator evidence store, not this public repository. Public summaries use only
redacted labels and hashes. Local fixture attestations are not independently
signed provider evidence. Preserve failures and cleanup evidence, not only a
success summary.

The existing E2B qualification validator and trust-verifier entry points accept
only the current `expected` pin names: `templateId`, `templateHash`,
`bootstrapArtifactHash`, `runnerArtifactHash`, and `adapterArtifactHash`. This host-supplied policy must
be a non-Proxy plain object with own enumerable data properties; misspellings,
unknown fields, symbols, hidden fields and accessors fail closed before external
observation verification. Omitted, `null` and `undefined` pins retain their existing
unset meaning. Supplied values must be canonical. A supplied `adapterArtifactHash`
must match the exact unique `evidence:e2b-risk-fork-adapter-artifact` ref/hash in
the existing qualification evidence. Add that ref to provisional evidence before
the independent observer signs its `base_evidence_hash`; the later distinct trust
signature binds the finalized evidence. Never retrofit a digest into already
signed evidence. Removing or changing the ref invalidates the signature chain,
even if its public evidence self-hash is recomputed.

The E2B adapter's optional host option `trustedAdapterArtifactHash` requires
qualification evidence and signed trust, and captures the expected pin privately
for both current and historical cleanup verification. Legacy evidence remains
parseable under existing local-test/diagnostic/cleanup contracts; it fails if a
host requires an artifact pin that the evidence does not contain.

This is a signed-artifact identity contract, not inspection or proof of loaded
code. The host must independently pin an authentic release/install digest,
measure the exact immutable installed artifact/closure before loading, and prove
its relation to the adapter actually executed. For the hosted package, the whole
deterministic runtime bundle is a conservative candidate artifact; a manifest
self-hash alone is not authenticity. Post-import disk hashes, mutable installs,
module-cache hits, caller-supplied registry hashes and private brands do not
establish loaded-byte provenance. That trusted install/load boundary, the reviewed
production qualification class and actual registry wiring remain incomplete.
No provider authority or activation path is added by this optional pin.

The SDK closure verifier also fences reuse of evaluated modules. Loads through
this verifier module are serialized; an entry is pinned to its first verified
closure digest, and failed evaluation/reinspection leaves it unusable until a
fresh process. Visible CommonJS cache entries must have the verifier's prior
exact file hash and module-object provenance. Unknown preloads, changed root or
transitive bytes, cache eviction/substitution and a new verifier factory do not
permit relabeling old code with a new disk digest. Unchanged exact verified
bindings can be reused. The exact SDK root must use its reviewed CommonJS
package profile; an ESM root claiming that identity is rejected. Provenance is
bounded to 32 entry attempts and 32,768 cached-file records; capacity requires a
fresh process, not cache eviction or bypass.

This cache fence still does not establish a clean first module graph, detect
every prior ESM dependency import, prevent a concurrent external import, or
make mutable package inspection atomic with evaluation. Node's transitive ESM
cache is not attested by CommonJS cache checks. Production loading still needs
a controlled fresh worker, authentic exact release pins and an immutable/read-only
installed closure before import; host module/cache custody is part of that
boundary. Keep live qualification false until that actual boundary is proved.

### Fresh host-owned SDK process boundary (source, not live qualification)

The internal SDK-process factory and the integrity verifier's
`{ processBoundary }` option now provide a closed Sandbox RPC facade. The factory
is not exported by the public core root, qualification subpath or hosted bundle.
Signed qualified/historical adapter construction can accept `sdkProcessOptions`
with exact artifact/Node/SDK paths and pins; the adapter privately constructs and
retains the process capability. No raw Sandbox facade is handed to its caller.
Qualified
and authentic historical-cleanup adapter paths require this original branded
process verifier at the last SDK-use fence; they cannot fall back to the legacy
same-process loader. The adapter's live source switch remains false. Template
build and live-qualification CLIs still use their existing same-process path;
this tranche does not qualify or activate those paths.

The host must provision a clean Linux controller, an authentic pinned Node
binary and runtime bundle, and a complete canonical read-only SDK closure.
The boundary checks non-root UID/GID, no root supplementary group, zero
effective/permitted/ambient capabilities, no-new-privileges, actual read-only
mount custody (including every resolved transitive file), and exact runtime and
Node hashes before import. It does not create a namespace, read-only mount,
network policy, immutable release, credential account or billing cap. Mount and
installer custody remain host prerequisites; chmod alone is not immutability.

The child uses fixed code and `process.execPath`, not inherited Node preload
arguments, a shell or an alternate loader. Environment inheritance is empty;
only an explicitly host-supplied provider key may be passed. No ambient provider
credential is retrieved. This process runs the trusted SDK, not untrusted MCP
code, and its provider methods are host-owned primitives, not an activation
grant. Host authorization, provider qualification and spend controls are still
required before any real provider call.

The factory owns a fresh Linux process group and attempts to kill that group
on retirement while its direct process is still owned and live. It cannot
prove custody of descendants that start a new session. The host must enforce
and observe an entire disposable cgroup/container before credentialed use;
this factory does not create that host fence. `sdk_process_terminated` means
only the direct process exit was observed (or no process was started), while
`sdk_process_tree_cleanup_verified` remains false. A provider-free detached
descendant test preserves that distinction; do not promote direct PID exit
into credential destruction or whole-tree cleanup proof.

IPC admits only fixed Sandbox operations, bounded plain results and opaque
private handles. Limits include eight retained processes, four pending calls,
2 MiB frames, 64 KiB binary chunks, 32 MiB aggregate upload buffers, 4 MiB reads,
256 MiB Node heap and a ten-minute maximum lifetime. Same-child mutations
reject concurrent entry rather than queue; emergency kill may interrupt a hung
command. Acknowledged kill retires local handles, not remote absence. Failed
effectful calls, timeouts, exit or malformed transport retire the boundary with
an unknown outcome; they never replay. Existing parent-owned journals and exact
metadata discovery remain responsible for recovery and independent absence.

`adapter.sdkProcessMetrics()` returns detached local counters for sent/completed RPCs,
worker-rejected pre-SDK calls, ambiguous effects, deadlines and observed process
starts/exits. These are not provider billing, managed-service telemetry, remote
cleanup evidence or production qualification. `adapter.closeSdkProcess()` separately reports
observed SDK-process termination and always leaves provider cleanup unverified.

Provider-free conformance from a reviewed public checkout (Docker/Linux with the
exact locally available image pinned in the launcher):

```sh
bash risk-fork/scripts/test-e2b-sdk-process-linux.sh /absolute/public/worktree
```

It uses a synthetic SDK, no network, no provider key, non-root read-only mounts,
dropped capabilities and no-new-privileges. It exercises fresh cache/env custody,
binary streams, cancellation, ambiguous allocation/command/write errors,
timeouts, emergency cleanup, cursor bounds, artifact-pin rejection and a
writable transitive submount. Its actual adapter recovery drill preserves the
journal across SDK-process exit, then requires new-process exact discovery,
kill and separate absence checks. This is local source proof only; no real E2B
allocation, final provider cost or independent production observer is exercised.

The same command also runs the fixed `verify-e2b-sdk-tree-observer.mjs` local
laboratory on the **Linux Docker host**, outside the fixture container. It
requires the local Unix Docker socket, host `/proc`, genuine cgroup v2 and the
systemd Docker cgroup layout; other layouts fail closed. The Docker controller
is a trusted host principal, never a socket mounted into the SDK fixture, an
MCP tool, a package runtime export or a production provider API. No privileged
or host-PID observer container is launched. The fixed image is already present;
there is no pull, network access, provider credential or arbitrary workload.

Before permitting synthetic SDK import, the observer binds the exact created
container ID, nonce label, image, limits, read-only source/fixture mounts, host
init PID start time and cgroup device/inode. It independently matches the
worker and new-session descendant against host process membership, observes
direct SDK-root exit **while the detached descendant remains**, and kills only
its identity-checked exact container. A second scenario cancels before the SDK
handoff. Missing permissions, daemon failure, stale identities, malformed
observations or unobserved creation outcomes are unknown, not cleanup success.
The lost-create-response cleanup path may recover only the exact unique lab
name after nonce/image/profile verification, then operate on its immutable ID;
it never prunes or accepts a label search as authority. Creation uncertainty
stays unknown even if this bounded emergency cleanup succeeds.

`scope_empty_before_remove` records either `empty_observed` (stable cgroup
two consecutive `populated=0`/empty-PID observations with stable scope identity
and all captured process incarnations gone), or
`kernel_scope_removed`. Docker's runtime can remove its cgroup as part of stop,
before `docker rm`; the latter requires the previously bound leaf to be absent
under its unchanged parent on the genuine cgroup-v2 mount, plus every captured
process incarnation gone. A missing file in a still-present scope is not this
proof. Kernel cgroup removal requires an empty tree; see the
[kernel cgroup-v2 lifecycle contract](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).
The fixture explicitly attempts cgroup migration/delegation writes and requires
denial. The outside observer separately checks the worker's read-only cgroup-v2
mount, non-root/capability/seccomp profile, root-owned non-worker-writable host
control files and absence of delegated child cgroups. The disappearance fallback
requires these no-migration custody checks, not fixture assertions alone.
Docker's stopped JSON or container absence alone cannot establish either state.
Only after kernel proof, exact removal and independent exact-ID absence may
`cleanup_status` become `verified`; this teardown lab also requires an observed
kill request and repeats kernel proof immediately before removal. PID reuse is
checked by start-time identity,
not by signaling a recycled host PID. Graceful interruption enters bounded
exact-ID cleanup; SIGKILL/power loss or unresolved allocation is still unknown.

These redacted lifecycle status/counter/duration snapshots use hashed container
references, not raw PIDs, scope paths, keys or SDK diagnostics. They are local
CLI evidence, **not durable hosted metrics or delivered alerts**.
`workload_completed` records only completion of the synthetic scenario;
`workload_passed` also requires `cleanup_status:verified` and no uncertainty.
A completed workload with unknown cleanup never reports a passed custody run.
They always
retain `credential_released:false`, `provider_calls:0`,
`provider_cleanup_verified:false`, `provider_billing_observed:false`, and
`production_qualified:false`. This lab does not wire the production SDK adapter
to a host supervisor: its `sdk_process_tree_cleanup_verified` remains false.
Actual credentialed launch custody, a production supervisor/observer, E2B
absence/final billing and the separately approved production gates remain open.
The external observer separately requires the exact duplicate-free image
environment-name set and explicit provider-key absence before handoff. The
outer launcher reports `lab_resources_cleanup_verified` only for temporary
local files/containers; that is not the observer's kernel `cleanup_status`.

### Cleanup recovery is not current qualification

The E2B adapter can recover already-journaled local export obligations after an
authentic observation receipt expires. Its cleanup-only provenance helper
(`verifyE2BCleanupQualificationProvenance`, reachable through the existing
`e2b-qualification` module subpath) preserves canonical evidence reconstruction,
caller-pinned independent observer/trust keys, both signatures, audience, exact
template/runtime pins, receipt ordering, maximum lifetime and rejection of future
issue time. It omits only the not-expired-now condition. This helper grants no
new effects or activation; it is not a production qualification receipt. New
savepoints, allocation, execution and lease renewal keep current verification.
An adapter constructed from expired evidence is permanently cleanup-only; a
backward clock or mutable status property cannot restore new-effect authority.
An adapter constructed while current also latches cleanup-only on its first
explicit expiry rejection; a later clock rollback cannot undo that decision.
The adapter captures qualification policy privately rather than trusting mutable
public status properties for cleanup authority.

Local-only restart reconciliation does not need an SDK. Real E2B provider I/O is
still source-disabled, including provider cleanup; such obligations remain
unresolved. The existing mock-only conformance seam cannot carry qualification
evidence. Before a mock provider kill, source checks the journal provider/template,
the requested persisted or exact-list identity, and exact returned sandbox ID,
template, profile, cleanup reference and metadata hash. It rechecks the persisted
binding after lookup and records cleanup intent before kill. Unknown/mismatched
observations or failed journal writes never establish absence. An already-absent
resource is verified separately and is not reported as an observed kill.

These are source/local-test controls, not multi-process journal locking or
managed operational qualification. The filesystem journal has an unkeyed
self-hash, not an authenticity signature; protected host ownership/ACL custody
and a qualified single-writer recovery boundary remain prerequisites before
real provider cleanup can be enabled. No live cleanup metrics or alert drill is
established by synthetic reconciled/unresolved record IDs. Preserve the separate
request-bound cleanup evidence contract and qualify the managed metrics/alerts
against actual recoveries before closing a production gate.

## 1. Source, CI and protected merge

Run both package checks/tests, the mandatory disposable PostgreSQL tests,
packed-consumer tests, documentation checks and scoped secret/private-material
inspection. Review the exact tested commit. Respect repository approval/status
requirements and retain the actual eligible review evidence. Record the
merge SHA separately from candidate/source proof. This gate enables no service.

## 2. Managed PostgreSQL roles and locking

Use a dedicated non-production PostgreSQL 16 database and separately provisioned
owner/migrator/runtime identities with validated TLS and secret-manager custody.
As database owner, apply the dedicated
[control-plane database bootstrap](./ops/postgres/control-plane-owner-bootstrap.sql.template)
before migration 001. It removes PUBLIC database CONNECT/CREATE/TEMPORARY,
grants CONNECT/CREATE to the migrator and CONNECT only to the runtime. The
disposable runtime-role test exercises this exact artifact. Then apply
immutable control-plane migrations 001–003 as the migration owner, then
the dedicated control-plane role template. Worker delivery uses its own schema,
ledger and role template; never combine their migration numbering. Both grant
templates remove the dedicated migrator's global PUBLIC function-EXECUTE default
within this database. Do not run them as a shared migrator.

Construct stores with `expectedOwner`; retain catalog and role reports. Prove
runtime API-key/tenant UPDATE, DDL, grants, memberships, DELETE/TRUNCATE, ledger
mutation and trigger-function execution are denied. Prove tenant suspension,
key revocation/scope/expiry changes serialize with mutation authority checks,
including clock/lease expiry after lock waits. Drift must deny work without
automatic repair. A catalog-only `initialize()` is not role qualification.

## 3. Edge identity, quotas, shutdown and alerts

Provision a real issuer and pinned public keys through an approved secret/key
rotation workflow. The offline verifier supports the dedicated Risk Fork JWT
profile only; bind it through `createTrustedOAuthAuthenticator` to persisted
credential truth. RSA keys must use public exponent 65537; token and persisted
credential windows are strict with no skew allowance. Test valid signatures,
exponent-one forgery rejection and wrong signature/kid/algorithm,
issuer/audience substitution, malformed/duplicate claims, expiration, withdrawn
scope, key revocation and cross-tenant identity. Require public TLS; keep worker
routes on a distinct authenticated network surface.

Back `consumeRateLimit` and `readControl` with an atomic durable service shared
by every instance. The optional [PostgreSQL backend](./REQUEST_POLICY.md) supplies
source/local-test evidence only. Use a dedicated policy database and roles;
never add its tables or grants to an already-attested control-plane or delivery
database. Construct its runtime with `expectedOwner`; source verifies its
independent frozen migration, exact PG16 catalog (including internal FK triggers)
and dedicated least-privilege runtime on every transaction. Retain current
deployed-role/catalog evidence; the local pass is not hosted qualification.
Drain the backend before owner DDL/ACL maintenance. Hosted TLS/rotation/HA,
capacity, retention and load qualification remain open. Fixed windows permit up to two
window quotas across a boundary; choose/review limits for that burst model.
Test combined per-key/per-tenant burst exhaustion across two
instances, fail-closed backend loss, bounded 429 retry, deadlines and retry
storms. Reserve cleanup/recovery capacity. Test disable changes while requests
wait; prove an effect-time broker fence rejects late execution and can stop
in-flight work. The source policy's pre-call decision cannot prove that last
property. Optional [durable policy telemetry](./TELEMETRY.md) now has a source-only
PostgreSQL observer outbox, bounded recording and lease-fenced delivery. This is
not an authority audit or provisioned alert delivery system. Qualify the exact
dedicated telemetry roles/TLS, sink custody, capacity/retention, recovery and
observed operator response; preserve failed/hung/unknown outcomes. Connect
durable redacted metrics/alerts for budget pressure, lease
expiry, provider errors, cleanup backlog/failure, audit failures and DB health,
and retain an observed alert/response drill without raw tokens or arguments.

## 4. Restore, failover, rotation and E2B

Database: restore an isolated backup/PITR target without overwriting the source;
compare migration/catalog hashes, immutable provider bindings, tenant budget
reservations, historical token tombstones, exact journal/delivery response
hashes and audit-chain anchors. Exercise approved failover/unknown-commit loss
against two instances: exact idempotency retries converge, only one logical
provider effect occurs, and resources reconcile before terminal completion.
Rotate DB credentials and delivery encryption keys while obligations remain;
old obligations must remain recoverable under the documented retention/key
policy. Retain timestamps, RPO/RTO, monitoring observations and verified cleanup
of disposable restore resources. Local Docker restart tests do not establish
managed high availability or point-in-time recovery.

Delivery source now supports one active encryption key plus at most eight
explicit retired decrypt-only keys, preserving immutable v1 ciphertext and
current worker authorization across restart. See [WORKER.md](./WORKER.md).
Retain keys for the full approved recovery/backup retention horizon; an empty
pending list is not a safe-retirement proof. Local in-memory and disposable
PostgreSQL rotation tests are not secret-manager, database credential rotation,
backup/PITR, or managed-service qualification evidence.

E2B: before the first paid allocation, establish the authorized total ceiling
and a hard enforceable bound including sandbox lifetime, concurrent allocation,
retries, teardown and delayed/finalized charges. Credit-card setup or a budget
alert alone is not proof of a hard cap. Pin account/template/runtime/SDK/adapter
and require provider-authenticated isolation evidence: no inherited parent
credentials, blocked first-instruction IPv4/IPv6/DNS egress where required,
filesystem/process boundaries, TTL, recovery-key lookup and independent final
absence verification for both resources. Verify costs after billing finalizes;
unresolved cleanup/cost keeps the qualification false. Do not promote fake-SDK
or provider-free test evidence into a live qualification receipt. If a cap or
isolation property cannot be established, allocate nothing and retain that gap.

## 5. Default-off staging and bounded canary

Only after the preceding evidence is reviewed, deploy the exact artifact to
non-production default-off, with no live agent traffic. Verify owner installation
and two-instance/restart conformance using real clients: principal/handle
substitution, lease/journal replay and response loss, wrong issuer/audience,
expired handles, MCP per-request metadata/header-body binding, malicious MCP
structured results, Apps active-content denial, cache poisoning, and disabled
MRTR/Tasks. Qualify a narrow enrolled-tenant canary separately with concurrency,
TTL, spend, expiry and kill-switch limits; no public allocation endpoint.
Retain out-of-band cleanup/absence and finalized cost before deciding whether
to activate. Keep deployment, provider qualification and live protection as
separate truth labels. No canary is authorized by this runbook itself.
