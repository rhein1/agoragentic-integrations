# Agoragentic Risk Fork

Risk Fork is an experimental, source-only package for **fork-before-risk** agent execution. It defines provider-neutral contracts for classifying a proposed interaction, capturing a reference-only Savepoint Capsule, executing in a tainted child, validating a narrowly typed result, destroying the child, and—only from a clean controller—committing an accepted artifact.

The short analogy is **“quick-save before the boss fight.”** The security model is stronger and more specific: fork a known-good state *before* risk, leave the trusted parent clean, clone no authority, treat every child result as tainted, and import only a bounded artifact after clean-side validation.

The package is not published, deployed, or enabled in the hosted Agoragentic runtime. `package.json` is intentionally marked `private`. **Production readiness is blocked. Risk Fork does not currently protect live Agoragentic MCP or Harness traffic.** Nothing in this directory proves production containment, live-provider operation, settlement, certification, or permission to take an external action.

The invariant is:

> **Clone state never authority.** A clone may carry bounded state needed to evaluate a proposal. It must not inherit credentials, signing material, wallet capability, approvals, reusable authorization, trusted identity, or permission to mutate the parent.

See [SECURITY_MODEL.md](./SECURITY_MODEL.md) before using any adapter. PostgreSQL provisioning, status, recovery, reconciliation, rollback, and deployment-drill requirements are in [POSTGRES_AUTHORITY_RUNBOOK.md](./POSTGRES_AUTHORITY_RUNBOOK.md). Provider research and the bounded E2B decision are in [PROVIDER_COMPARISON.md](./PROVIDER_COMPARISON.md). The exact failing-before evidence, working-tree fixes, source-review requirements, and separate production-readiness gates associated with PR #298 are recorded in [ADVERSARIAL_REMEDIATION.md](./ADVERSARIAL_REMEDIATION.md).

## Current status

| Surface | Status | Honest boundary |
| --- | --- | --- |
| Deterministic risk classifier | Experimental source implementation | No LLM decision path; incomplete capability metadata is treated as unknown/`HIGH`, and owner policy can only raise the minimum or deny |
| Savepoint Capsule, fork identity, execution binding | Experimental source implementation | The public v1 capsule permits no runtime snapshot or a verified filesystem-only snapshot; process-memory/runtime snapshots are invalid, and hashes/references are evidence rather than grants |
| Hash-linked lifecycle | Experimental source implementation | A destroy request and a verified absence observation are separate facts |
| Taint gate | Experimental source implementation | Imports only a typed result, bounded workspace diff, or consequential-action proposal; child-asserted test evidence cannot satisfy current required-test policy without clean re-execution or a trusted external attestation |
| Clean commit | Experimental source implementation | Demonstration mode can use the concrete file reference transactions; both production controller construction and the public clean-commit boundary require the exact branded PostgreSQL authority configured for production, verify-only migration mode, and verified CA-authenticated TLS |
| PostgreSQL distributed authority | Implemented with disposable local TLS/role evidence | Server time, serializable row locks, exact approval/authorization reservation and consumption, durable ambiguity, success-only finalizing reconciliation, and an append-only global audit chain are implemented. A separate migrator, exact migration/catalog/trigger/privilege attestation, and executable owner/migrator/runtime role templates are locally tested against a fresh TLS PostgreSQL database; no managed HA, failover, multi-region, backup/restore, retention, monitoring, or deployment qualification is claimed |
| Local reference adapter | Implemented protocol simulator | A non-empty source is attested authority-free before copy, then run through a constrained child process; **not an isolation boundary or kernel network control** |
| E2B adapter | Reviewed clean-template/runtime source; live allocation source-disabled | The package includes reviewed template, boot-guard, bootstrap, runner, and runtime-contract artifacts; an independent exact-byte clean-side source verifier; and default-off owner-gated build/live qualification harnesses. The live harness now consumes approval/run authority through durable exclusive claims before SDK loading, bounds every controller wait while passing abort signals to supported SDK operations, revalidates exact lease observations, requires an explicit kill acknowledgement, and uses three freshness-spaced typed-provider exact-bound absence observations; ambiguous allocation remains unknown, and every exact-bound duplicate is cleanup-attempted once before the run is rejected. Canonical evidence can become qualification-eligible only when it embeds a pinned, re-verifiable observer receipt and a separate qualification-trust signature verifies the exact template/runtime/SDK bindings. The captured watcher is not an independent authority boundary, so even eligible evidence remains `evidence_present_activation_blocked`: live adapter allocation, leases, and production capability flags stay disabled in source. Windows evidence-producing entrypoints now fail before claims, SDK loading, or provider I/O until exact DACL validation exists. One owner-authorized no-retry provider canary returned `unknown`; no successful live qualification, containment, lifecycle, latency, or finalized per-sandbox cost proof is checked in |
| Daytona and AWS/Firecracker | Research only | No adapter and no production-readiness claim |
| Hosted/MCP/Harness integration | Source-only and not production-wired | A fail-closed host-enforcement bundle and planner seam have source/loopback contract evidence, but neither is installed into the hosted runtime or supplied by existing callers; no hosted or live interception is enforced |
| Production readiness | **Blocked** | Neither execution adapter is an approved production isolation boundary, hosted interception is not enabled, the PostgreSQL authority is not deployed or managed-service qualified, and no live traffic is protected |
| Performance and provider cost | Local reference benchmark plus one diagnostic provider sample | The live canary observed 1,641 ms to allocation and 2,303 ms for cleanup, but one failed-closed sample is not a benchmark or SLO; live MCP latency, containment, and exact provider cost remain unqualified |

On 2026-08-25 UTC, an owner-authorized one-shot canary against exact source head `0d26014d9f0b847b5f4929ccb43d34c31db7c605` created one synthetic sandbox and returned canonical `status: unknown` evidence. The run failed closed at the initial provider-info/binding stage before bootstrap, inherited-state, network, or lease controls could become verified. That historical artifact retained only a hashed generic error classifier, so it cannot distinguish the initial provider-info fetch from its exact contract predicate. Current source fixes that diagnostic gap for future runs with paired closed `failure_stage`/`failure_class` enums and never serializes raw provider errors; legacy evidence that omits those optional fields remains canonical. Older closed-schema v1 readers must be upgraded before accepting newly emitted diagnostic fields. Cleanup separately recorded an explicit provider kill acknowledgement, three freshness-spaced absence observations, and exact-bound orphan reconciliation as `verified`; the task key was then revoked, and the provider console showed zero live/listed sandboxes, zero keys, and `$0.00` aggregate usage at observation time. The provider did not supply a finalized per-sandbox cost receipt, so cost remains `unknown`. All authority flags are false, the external observer receipt is null, and production activation remains false. The evidence hash is `sha256:fa3c6cc861189b3453a0ca9c49efac2a3fe7ebf3cb7ab225a2e28b0489fe14e8`. The consumed approval/run claims are not retry authority, and this diagnostic result is not a qualification artifact.

The deterministic suite includes dedicated PostgreSQL contract, independent-process race, crash/ambiguity, revocation, audit, and clean-controller integration tests. Pushed-head CI is authoritative only for the exact commit shown on PR #298 and must be checked there; local green results do not establish production readiness.

PR #298's source-only/default-off merge is gated by exact-head CI and genuine independent human approval, not by live-provider or production-readiness qualification. Merging source grants no deployment, provider-use, spend, live-traffic, publication, or production-activation authority. Those gates remain independently blocked.

Run the repository checks for the exact checkout before relying on a source surface:

```powershell
cd risk-fork
npm install
npm test
npm run test:postgres # requires RISK_FORK_TEST_POSTGRES_URL
npm run check
npm run benchmark:local
npm run pack:dry
```

Passing local checks is not proof that a cloud adapter is deployed, that network isolation is effective, or that a provider object was destroyed.

The following commands are mutation, provider, or spend-adjacent operator entrypoints—not ordinary checks—and remain disabled unless their explicit environment gates are satisfied:

```powershell
npm run e2b:build-template
npm run e2b:live-qualification
npm run postgres:migrate
```

Do not run them without explicit owner authorization, a synthetic/no-production-secret scope, bounded cost/network approval for E2B, or a dedicated migration database and CA for PostgreSQL. Merely exposing these commands does not mean a live qualification or deployment occurred.

The repository adapter-conformance worker uses a request-correlated result/ACK handshake: the worker holds its terminal exit until the coordinator acknowledges the exact result, and the coordinator accepts the outcome only after ACK delivery completes and the worker exits consistently. This replaces timing-grace behavior; it is process-ordering evidence, not adapter containment evidence.

The production blockers are tracked in [#301 (hosted MCP interception)](https://github.com/rhein1/agoragentic-integrations/issues/301), [#302 (sanitized E2B boot and live qualification)](https://github.com/rhein1/agoragentic-integrations/issues/302), and [#303 (distributed transaction authority)](https://github.com/rhein1/agoragentic-integrations/issues/303). The source implementation for #303 now includes CA-verified TLS, separate migration, exact schema/privilege attestation, least-privilege templates, and disposable local TLS/role evidence, but the issue is not production-closed until a reviewed managed deployment proves HA/failover, backup/restore, retention, monitoring, and operational reconciliation.

## Risk policy

The deterministic classifier returns one of four levels:

| Level | Default action |
| --- | --- |
| `LOW` | Normal execution |
| `ELEVATED` | Risk Fork optional |
| `HIGH` | Risk Fork required |
| `IRREVERSIBLE` | Prepare in the fork, then clean revalidation and commit |

Unknown, failed, or untrusted MCP servers classify at least `HIGH`. A raw `verified` label cannot lower trust: the classifier also requires an exact, fresh attestation whose server ref/origin, trust-registry version, attestor, hash, and integrity fields match owner-trusted policy. An absent or partially enumerated capability manifest is also unknown and therefore `HIGH`; callers must explicitly supply every capability boolean to establish a lower result. Instruction-bearing phases such as `server/discover`, `initialize`, `tools/list`, `resources/read`, and `prompts/get` are classified before their content may enter the clean context. An unrecognized method uses `UNKNOWN`, preserves a bounded raw method for evidence, and classifies `HIGH`. Money movement, deployment, publication, external communication, database mutation, and trust/reputation mutation classify as `IRREVERSIBLE`. MCP annotations are inputs, not authority, and cannot lower a decision.

## Protocol

1. A clean controller classifies the effective interaction before remote instruction-bearing content is accepted.
2. It creates a Savepoint Capsule capped at 64 KiB containing hashes and opaque references—including allowed commit types and, when already applicable, an authorization reference/hash pair—not raw prompts, conversations, memories, workspace contents, secrets, tokens, grants, or private local paths. Its public v1 `runtime_snapshot.mode` is restricted to `none` or independently attested `filesystem`; a memory/process/runtime snapshot is invalid even if labeled verified.
3. It creates a child with a fresh agent ID, session ID, runtime identity, nonce namespace, and entropy reference.
4. Any production provider must establish network and lifecycle restrictions before the child starts and import only a demonstrably sanitized filesystem payload. The E2B adapter is fail-closed when its complete clean-template profile is absent. When configured, it stages an immutable exact-byte filesystem export with a hash-bound manifest; a clean-side second pass reopens the staged bytes, rechecks them, verifies reviewed runtime artifact hashes, and requires a detached signature from a pinned independent verifier before upload. Child birth uses a pinned reviewed template with empty environment, IAM-token, and mount requests plus deny-all SDK network settings. A captured network-silent watcher accepts one canonical nonce-bound request only after the controller exact-binds `Sandbox.getInfo`, then emits a request-bound boot attestation before any bootstrap command, identity, or workspace upload. These are source/offline/mock-qualified controls, not live proof that E2B blocks first-instruction or IPv6 egress or excludes inherited provider state.
5. Every child output remains tainted. There is no child-to-parent conversation merge or memory merge.
6. The taint gate may prepare exactly one of:
   - `TYPED_RESULT`
   - `WORKSPACE_DIFF`
   - `CONSEQUENTIAL_ACTION_PROPOSAL`
7. A child consequential-action candidate contains only the proposed action. The clean side creates and attaches the execution binding; the child never receives or returns the authorization reference, hash, nonce, or one-use identifier.
8. The provider is asked to destroy the fork and savepoint; separate verification must establish destruction. Unknown or failed verification remains explicit.
9. A clean controller first performs advisory current-governance and exact-approval preflight. In production mode, the concrete `PostgresDistributedCommitAuthority` must itself be constructed for `deploymentMode: 'production'`, `migrationMode: 'verify-only'`, and verified CA-authenticated TLS. It then locks the parent, governance, approval, and optional authorization rows in a fixed order under a serializable transaction, uses PostgreSQL server time, and runs the final clean revalidation before reserving the exact rows. Demonstration mode may instead use the concrete file reference transactions. Callback-based authority substitutes, development/apply-mode PostgreSQL instances, duck-typed authorities, mixed authority backends, and caller-injected controller authority are rejected.
10. The PostgreSQL authority durably records `prepared`, then `effect_started` with a unique `effect_key`, before synchronously invoking the clean effect callback. The key is passed downstream for fencing/idempotency; it does not grant authority and does not prove generic exactly-once external effects. There is no automatic invocation after `effect_started` or `ambiguous`. Exact committed replay returns the stored result. Trusted exact-version reconciliation may finalize only exact proven success; a point-in-time absence or failure observation leaves the operation ambiguous and keeps the parent, approval, and one-use authorization unavailable because the original callback may still complete. File transactions retain only local single-filesystem reference semantics.
11. A hash-bound receipt cross-binds lineage, fork/provider, risk decision, artifact, destruction evidence, optional authorization reference, and lifecycle-derived timestamps without embedding authority or raw private content.

## What was reused, extended, and added

| Classification | Primitive | Treatment in Risk Fork |
| --- | --- | --- |
| **EXTEND** | Transaction Assurance canonical JSON ordering and SHA-256 helper | Risk Fork first validates and canonicalizes every JSON type, including strings, before hashing. Object/array canonical ordering is reused, but Risk Fork string references intentionally differ from Transaction Assurance's raw-string convenience references so textual JSON cannot collide with the value it represents; neither namespace's evidence is authority, certification, or settlement proof |
| **REUSE** | Existing authoritative policy, approval, revocation, credential, and action-execution subsystems | Consumed through clean-side verifier/executor callbacks; Risk Fork does not replace or mint their authority |
| **NEW** | Local file-backed parent-head and execution-authorization transactions | Demonstrates fail-closed, under-lock reference semantics in demonstration mode only; production mode rejects it |
| **NEW** | PostgreSQL distributed commit authority | One shared authority owns parent/governance/approval/authorization state, DB-time row ordering, effect fencing, reconciliation, and a serialized append-only audit chain. Runtime verification, DDL migration, and owner/migrator/runtime provisioning are separate surfaces; production managed-service qualification remains open |
| **EXTEND** | Transaction Assurance evidence envelopes and receipt linkage | Risk Fork receipts can reference external evidence while explicitly setting settlement/certification claims to false |
| **EXTEND** | Existing governance and exact action binding | Adds fork identity, MCP origin/method, effective arguments, provider, target, amount, policy/mandate/budget refs, versions and hashes, governance epoch, validity window, nonce, audience, and one-use authorization ID to the commit boundary |
| **EXTEND** | Tool interception | Adds a fail-closed host-enforcement bundle and planning seam with source/loopback coverage before real MCP `server/discover`; hosted installation and live phase coverage remain follow-up work |
| **NEW** | Savepoint Capsule and fresh fork identity | Bounded, content-excluding state contract plus new child identity/entropy namespace |
| **NEW** | Risk classifier, lifecycle, taint gate, clean-commit composition, and Risk Fork receipt | Provider-neutral v1 contracts with fail-closed transitions and explicit unknown states |
| **NEW** | Provider interface and adapters | Local protocol simulator plus an E2B adapter that defaults to fail-closed, reviewed clean-template/runtime artifacts, an independent exact-byte source verifier requiring detached pinned trust, and default-off qualification tooling. One live diagnostic record exists with `status: unknown`; no successful live E2B qualification is claimed |

## Source surfaces

The package export map exposes the main module plus focused subpaths:

```js
import { classifyRisk } from '@agoragentic/risk-fork/classifier';
import { LocalReferenceRiskForkAdapter } from '@agoragentic/risk-fork/adapters/local-reference';
import { PostgresDistributedCommitAuthority } from '@agoragentic/risk-fork/adapters/postgres-authority';
```

The qualification API set in the first import below is available from both the package root and its focused subpath. The adapter and source-verifier imports show their complete focused contracts: the root also re-exports `E2BRiskForkAdapter`, `createE2BAuthorityFreeSourceVerifier()`, and `scanE2BStagedBytesAuthorityFree()`, while the named secure-profile error constant and independent-source schema remain focused-only. Every path exposes validation mechanics, never provider authority:

```js
import {
  E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS,
  E2B_EXTERNAL_QUALIFICATION_OBSERVATION_SCHEMA,
  E2B_EXTERNAL_PROVIDER_CONTROLS,
  E2B_QUALIFICATION_SCHEMA,
  E2B_QUALIFICATION_TRUST_SCHEMA,
  E2B_RUNTIME_SDK_INTEGRITY_SCHEMA,
  applyE2BExternalQualificationObservation,
  createE2BExternalQualificationObservationVerifier,
  createE2BQualificationTrustVerifier,
  createE2BRuntimeSdkIntegrityVerifier,
  isE2BQualificationEvidenceCanonical,
  loadVerifiedE2BRuntimeSdk,
  validateE2BQualificationEvidence,
  verifyE2BExternalQualificationObservation,
  verifyE2BQualificationTrust,
} from '@agoragentic/risk-fork/e2b-qualification';
import {
  E2B_INDEPENDENT_SOURCE_ATTESTATION_SCHEMA,
  createE2BAuthorityFreeSourceVerifier,
  scanE2BStagedBytesAuthorityFree,
} from '@agoragentic/risk-fork/adapters/e2b-source-verifier';
import {
  E2BRiskForkAdapter,
  E2B_SECURE_SNAPSHOT_PROFILE_UNAVAILABLE,
} from '@agoragentic/risk-fork/adapters/e2b';
```

The adapter subpath also exposes `performE2BSandboxBirthHandshake()` for the gated live harness. It accepts only an already-allocated sandbox handle and performs the bounded, authority-free request/attestation file exchange; it cannot load the SDK, allocate, list, lease, or kill a sandbox. It is a post-allocation validation primitive, not an owner gate, provider capability, qualification result, or activation path. The sandbox-allocating inner canary is deliberately private to the gated live-qualification module and is not exported.

`createE2BQualificationEvidence()` creates only closed, self-hashed **provisional** evidence: its externally observed controls must remain `unknown`, its actual sandbox cost must remain null, and its `external_observation_receipt` is null. The live harness emits that provisional shape for IPv4, IPv6, cost, template-provenance, bootstrap-binding, runner-binding, hard-TTL, idle-TTL, and maximum-execution controls. Before SDK loading or provider I/O it writes approval-scoped and full-run-scoped exclusive attempt claims that are never deleted or rearmed. Its hash-only bindings cover the exact approval, run, project, SDK, template/build/provenance, reviewed runtime artifacts, requested limits, canary, sandbox, provider metadata, post-allocation birth request, birth attestation, boot evidence, both first-instruction probes, exact lifecycle observations, provider kill acknowledgement, and freshness-spaced terminal absence evidence. Boot evidence observed before the sandbox allocation attempt is rejected as captured template-build state. A create call whose outcome cannot be bound to one sandbox reports zero observed sandboxes and unknown reconciliation; an empty listing alone cannot upgrade it.

`evidence_refs` are semantically keyed by `ref`: source validation rejects a repeated `ref` even when its hashes differ. JSON Schema `uniqueItems` can reject only identical whole records, so the schema documents but cannot independently express this keyed-uniqueness rule.

The `agoragentic.risk-fork.e2b-qualification-evidence.v1` shape is a private-alpha draft contract, and this security tranche deliberately replaces that draft in place by adding the embedded observer receipt and exact six-decimal cost rules. It is not backward-compatible with earlier `v1` draft artifacts. The core package, generated hosted bundle, and private hosted consumer must therefore be rebuilt and released atomically; older draft evidence and older generated consumers are unsupported and must fail closed rather than be treated as compatible.

`applyE2BExternalQualificationObservation()` is the only evidence finalizer. It embeds the exact canonical signed observer receipt—including the signed payload, Ed25519 SPKI, key hash, observation hash, signature, requested limits, bindings, network claims, provider-control records, and distinct cost records—rather than retaining only hashes. Every later `validateE2BQualificationEvidence()` call for finalized evidence requires the caller-pinned observer verifier, re-verifies the embedded signature, reconstructs the provisional base, and deterministically re-derives every finalized control, cost, and evidence reference. Provider cost cap, derived estimate, aggregate console delta, and finalized per-sandbox actual cost are separate receipt records; a missing finalized actual cost leaves `cost_within_cap=unknown`. A boot-local IPv6 denial or no-route result cannot become verified without separately signed provider IPv6-denial evidence. Missing, changed, mismatched, unsigned, duck-typed, or timeout-ambiguous evidence fails closed as an error or remains `unknown`.

Adapter qualification still requires every mandatory control to be verified plus a separate `verifyE2BQualificationTrust()` signature over the finalized evidence. The observer and qualification-trust Ed25519 SPKI hashes must differ, and both the evidence validator and trust verifier must receive the caller-pinned external-observation verifier. Neither signature grants production activation. Qualified SDK loading separately requires the module-branded runtime-integrity verifier.

Because the package is source-only and private, the checked-in example imports source files directly. Run it only as a protocol demonstration:

```powershell
node examples/local-reference.mjs
```

The example prepares a typed artifact in an empty disposable workspace, destroys and independently verifies the local copies, and stops before clean commit. It does not contact a provider, spend funds, use credentials, or demonstrate real isolation.

Risk Fork currently reuses the adjacent source checkout at `transaction-assurance/src/canonical.mjs`. Consequently, `npm pack --dry-run` is a contents audit, not proof that the tarball is independently installable outside this monorepo. A future publication tranche must replace that source-relative edge with a resolvable reviewed package dependency before removing `private: true`.

### PostgreSQL authority operations

Production runtime construction is deliberately verify-only. It requires CA-authenticated TLS, rejects connection-string TLS overrides and unsafe startup options, fixes synchronous commit on, and verifies transport, durability, replication-trigger mode, reviewed migration hashes, exact relation/column/constraint/index/foreign-key/trigger-function catalogs, and least-privilege runtime posture before authority use. Runtime checks include session/current-role equality, safe role attributes, no inherited memberships, bounded database/schema/table/column/function privileges, and exact audit-trigger enablement.

DDL belongs to the separate PostgreSQL migrator. `ops/postgres/owner-bootstrap.sql.template` is the database-owner pre-migration step; `ops/postgres/roles.sql.template` is the migrator-owned post-migration grant/default-privilege step. A disposable local TLS test creates a fresh database and distinct migrator/runtime logins, executes both rendered templates and the reviewed migration, then exercises production verify-only initialization and privilege-escalation failures. That evidence is local and ephemeral: it does not qualify a managed cluster, failover, backup/restore, retention, monitoring, credential rotation, or deployment operations.

Follow [POSTGRES_AUTHORITY_RUNBOOK.md](./POSTGRES_AUTHORITY_RUNBOOK.md) for the exact provisioning order, redacted read-only status/alert contract, prepared-only recovery, no-auto-retry reconciliation boundary, routing-disable rollback, and the managed backup/PITR/failover/restore/rotation evidence still required before activation.

The local benchmark runs five disposable forks and reports observed savepoint, fork-start, closed-operation, diff, and destruction timings plus capsule/diff sizes:

```powershell
npm run benchmark:local
```

It deliberately reports live MCP latency, cloud-provider behavior, containment, and provider cost as unmeasured. Its output is a checkout- and machine-specific observation, not an SLO.

## Provider contract

Adapters implement:

- `createSavepoint`
- `createFork`
- `getForkStatus`
- `executeInFork`
- `collectEvidence`
- `collectDiff`
- `suspendFork`
- `destroyFork`
- `verifyDestroyed`
- `destroySavepoint`
- `verifySavepointDestroyed`

Capability flags are declarations that must be independently tested. `supports_verified_destruction: true` does not itself prove an individual resource was destroyed. Production mode requires declared hard TTL, idle TTL, maximum execution-time enforcement, and either prohibited child credentials or automatic credential expiry. The local adapter and every E2B profile in this source keep `supports_idle_ttl: false`. Signed qualification evidence can be retained and revalidated, but it cannot turn on a provider capability while `E2B_LIVE_FORK_SOURCE_ENABLED` is hard-false.

The E2B adapter has four deliberately separate states: unavailable, configured-but-unqualified, qualification-evidence-present, and `evidence_present_activation_blocked`. Construction requires a clean-side `verifyAuthorityFreeSource` function plus reviewed `trustedBootstrapArtifactHash` and `trustedRunnerArtifactHash` values in every state. If any of `cleanTemplateId`, `cleanTemplateHash`, `cleanTemplateProvenanceHash`, `workspaceExportDirectory`, or `cleanupJournalDirectory` is absent, the profile is unavailable: `createSavepoint`, `createFork`, and `executeInFork` throw `E2B_SECURE_SNAPSHOT_PROFILE_UNAVAILABLE` before SDK loading, verification callbacks, or provider I/O, and the capability profile declares provider support false or unverified.

When all five clean-template settings are present, the configured source profile is usable for strict offline/mock conformance only when `offlineConformance: true` accompanies an injected `SandboxClass`. Every injected SDK/provider path requires that explicit mock-only seam and cannot carry qualification evidence or trust. Real SDK/provider access and every live-fork operation remain source-disabled. The offline profile:

- enumerates a bounded source tree through stable file handles, rejects secret-shaped paths/content plus symlinks, hard links, special files, and case/Unicode collisions, and stages the accepted exact bytes in a read-only immutable export with a hash-bound manifest;
- requires an external clean-controller attestation exact-bound to that manifest, workspace digest, pinned clean template, and trusted bootstrap/runner artifacts;
- requests child birth from that pinned template with `envs: {}`, empty IAM tokens, no mounts, a hard deadline with kill/no-auto-resume, and the E2B SDK's declared all-traffic deny sentinel, then completes a one-use post-allocation birth request/attestation before any bootstrap command, identity, or upload;
- requires exact provider metadata echo plus fresh pre-upload and post-import bootstrap attestations, and exact-binds each unique runner job and result to the capsule, child identity, network policy, operation, execution mode, trusted runner, and authorized result schema;
- imports result bytes only through a fixed 4 MiB streamed buffer with controller-total and stream-idle deadlines, abort/cancel behavior, and fail-closed child cleanup on timeout, stall, overflow, or binding failure; and
- writes cleanup intent before allocation, persists export/sandbox cleanup state, reconciles exact metadata-bound orphans across restart, and poisons every later allocation whenever cleanup is unknown until both sandbox and export absence are independently recorded.

The reviewed `e2b-template/` source contains the template definition, first-boot guard, bootstrap, fixed runner, and shared runtime contract. On each watcher start, the non-root boot guard atomically creates a fresh mode-`0700` one-use leaf under the root-owned sticky `/tmp` directory, refuses every preexisting target including an empty directory, and revalidates the directory identity around request consumption and evidence publication. The clean-side source-verifier factory independently reopens the immutable staged export, scans the exact bytes again, verifies the reviewed bootstrap/runner file hashes, and accepts absence claims only when a detached Ed25519 signature matches a pinned independent-verifier public-key hash. These are stronger fail-closed source contracts than a self-asserted callback, but neither the same-UID watcher nor the source verifier is independent cloud-containment evidence.

Qualification evidence is closed, canonical, self-hashed, and exact-bound to `e2b@2.39.0`, the template/build/provenance hashes, reviewed runtime artifacts, a single synthetic sandbox, explicit lifecycle/network controls, cleanup observations, and bounded cost. A self-hash never qualifies the adapter. Finalized evidence must embed a signed Ed25519 observer receipt that can be re-verified offline against caller-pinned policy; hash-only observer references are insufficient. Qualification additionally requires a distinct Ed25519 qualification-trust signature bound to the finalized evidence hash. The current adapter can retain and revalidate those bindings but cannot load the SDK, call the provider, allocate a live child, or arm/renew `setTimeout`: the same-UID watcher keeps activation hard-blocked in source. The lease implementation remains dormant code for a future separately privileged watcher design and must not be described as active capability.

The build and live harnesses are default-off. They require explicit owner refs, synthetic scope, provider/network/spend flags, an absolute evidence directory, exact hashes, and a code-capped cost budget before loading the SDK or making provider calls. Because Node mode bits do not establish confidentiality or one-shot integrity on Windows, both evidence-producing entrypoints now throw `E2B_WINDOWS_EVIDENCE_DACL_UNVERIFIED` before claims, SDK loading, or provider I/O on `win32`; native Windows support remains blocked until repository-controlled exact DACL validation covers the directory, every file, inheritance, broad ACEs, reparse paths, and parent/delete semantics. On supported POSIX hosts, before `Template.build` or `Sandbox.create` can contact E2B, the corresponding harness durably creates both a sanitized approval-scoped exclusive claim and a self-hashed, run-bound attempt intent; a reused approval, prior run intent, or legacy final evidence for that run stops before provider I/O. These records are never deleted or overwritten, their provider outcome remains `unknown`, and any provider-touching error or interruption is terminal rather than retry authority. The live controller additionally bounds every controller wait, passes abort signals to supported SDK operations, exact-validates initial/execution/idle lease observations, accepts only an explicit positive kill acknowledgement, and requires three freshness-spaced exact `SandboxNotFoundError` plus exact-metadata/template empty-list observations before local cleanup can verify. A missing sandbox identity, an untyped 404, or an ambiguous create outcome remains unknown even when a later listing is empty. It retains every newly discovered exact-bound sandbox identity, issues at most one static exact-ID kill call per identity after any unbound handle cleanup, rechecks for late duplicates, and rejects the run without qualification evidence if more than one sandbox was observed. The harnesses emit sanitized provisional evidence with `external_observation_receipt: null` and all authority flags false; they do not sign their own observer receipt or qualification trust and never grant production activation. Finalization requires an independent observer to sign the exact network, provider-control, requested-limit, provider-cap, derived-estimate, aggregate-console-delta, and finalized per-sandbox cost bindings through the external-observation API above. If E2B exposes no provider-backed IPv6-denial evidence or no finalized per-sandbox actual cost, those controls remain `unknown` and strict qualification cannot pass. The single owner-authorized live canary produced only provisional `status: unknown` evidence with verified kill/absence/orphan cleanup; no successful live qualification, external observation, or qualification/trust artifact is checked in. `credentialed_provider_validation`, `containment_claim`, and `supports_idle_ttl` therefore remain unqualified for the repository's current evidence. Live first-instruction/IPv6 egress, inherited-state absence, provider-finalized cost, and independent qualification remain unproven.

The configured capability flags without trusted qualification describe contract behavior exercised with dependency-injected mocks; they are not provider attestations. The local adapter likewise requires a manifest-bound clean-side verifier before it copies any non-empty source; empty workspaces use an explicit empty-snapshot proof.

For a non-empty local source, `verifyAuthorityFreeSource(request, { snapshot_directory })` runs on the clean source before copy. It must return the closed `agoragentic.risk-fork.local-authority-free-attestation.v1` shape, echo the exact request/capsule/workspace hashes, provide opaque evidence ref/hash values, and set the four absence claims (`authority_free`, `credentials_absent`, `wallet_material_absent`, and `execution_authority_absent`) to `true`. This callback is a trusted boundary; a careless self-assertion defeats the reference adapter's pre-copy safeguard.

## Commit artifacts are not authority

A validated artifact is still derived from a tainted child. It records what passed deterministic checks; it does not authorize execution. Likewise:

- a Savepoint Capsule is not an approval;
- a Risk Fork receipt is not a credential or settlement receipt;
- a Transaction Assurance evidence reference is not permission to act;
- a provider success response is not verified destruction;
- a child-produced signature or approval field is rejected rather than trusted.

Receipt verification has two deliberately separate APIs. `verifyRiskForkReceiptStructure()` proves only the receipt's closed schema, internal semantic consistency, and self-hash. The authoritative `verifyRiskForkReceipt()` additionally requires the exact full risk decision out of band, deterministically verifies that decision, and binds its level, action, decision hash, and policy status to the receipt. If the decision records trusted-server verification, the caller must also provide the original live `trusted_server_verifier`; serialized verification metadata cannot be replayed as provenance. Neither API turns the receipt hash into a signature or authenticity proof, so consumers still need an external signer or authoritative receipt store when creator provenance matters.

For irreversible work, the fork may only **prepare**. The authoritative action occurs later through a clean executor after exact revalidation and one-use authorization consumption.

## OSS and commercial boundary

This directory may contain provider-neutral contracts, deterministic validation, schemas, local reference tooling, public adapter code, and sanitized conformance fixtures.

It must not contain hosted-provider credentials, customer data, private prompts or memories, wallet/signing material, tenant policies, live commercial routing, private Full ECF internals, private connectors, operator artifacts, or production access evidence. Hosted Triptych OS services remain responsible for tenancy, authoritative policy and mandate evaluation, billing/provider accounts, live interception, signing, settlement, private enterprise runtime integration, and operations. Those capabilities are neither bundled nor implied here.

## License

The Risk Fork package is available under the [MIT License](./LICENSE). This license does not turn an experimental reference adapter into a security boundary or confer access to hosted/commercial services.
