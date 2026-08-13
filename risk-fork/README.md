# Agoragentic Risk Fork

Risk Fork is an experimental, source-only package for **fork-before-risk** agent execution. It defines provider-neutral contracts for classifying a proposed interaction, capturing a reference-only Savepoint Capsule, executing in a tainted child, validating a narrowly typed result, destroying the child, and—only from a clean controller—committing an accepted artifact.

The short analogy is **“quick-save before the boss fight.”** The security model is stronger and more specific: fork a known-good state *before* risk, leave the trusted parent clean, clone no authority, treat every child result as tainted, and import only a bounded artifact after clean-side validation.

The package is not published, deployed, or enabled in the hosted Agoragentic runtime. `package.json` is intentionally marked `private`. **Production readiness is blocked. Risk Fork does not currently protect live Agoragentic MCP or Harness traffic.** Nothing in this directory proves production containment, live-provider operation, settlement, certification, or permission to take an external action.

The invariant is:

> **Clone state never authority.** A clone may carry bounded state needed to evaluate a proposal. It must not inherit credentials, signing material, wallet capability, approvals, reusable authorization, trusted identity, or permission to mutate the parent.

See [SECURITY_MODEL.md](./SECURITY_MODEL.md) before using any adapter. Provider research and the bounded E2B decision are in [PROVIDER_COMPARISON.md](./PROVIDER_COMPARISON.md). The exact failing-before evidence, working-tree fixes, and remaining gates for PR #298 are recorded in [ADVERSARIAL_REMEDIATION.md](./ADVERSARIAL_REMEDIATION.md).

## Current status

| Surface | Status | Honest boundary |
| --- | --- | --- |
| Deterministic risk classifier | Experimental source implementation | No LLM decision path; incomplete capability metadata is treated as unknown/`HIGH`, and owner policy can only raise the minimum or deny |
| Savepoint Capsule, fork identity, execution binding | Experimental source implementation | The public v1 capsule permits no runtime snapshot or a verified filesystem-only snapshot; process-memory/runtime snapshots are invalid, and hashes/references are evidence rather than grants |
| Hash-linked lifecycle | Experimental source implementation | A destroy request and a verified absence observation are separate facts |
| Taint gate | Experimental source implementation | Imports only a typed result, bounded workspace diff, or consequential-action proposal; child-asserted test evidence cannot satisfy current required-test policy without clean re-execution or a trusted external attestation |
| Clean commit | Experimental source implementation | The included concrete file parent transaction owns the parent head, current governance, and exact one-use approval under one lock through the accepted effect; consequential execution nests the concrete file authorization transaction as the sole local revocation/use authority |
| Local reference adapter | Implemented protocol simulator | A non-empty source is attested authority-free before copy, then run through a constrained child process; **not an isolation boundary or kernel network control** |
| E2B adapter | Fail-closed safety stub | `createSavepoint`, `createFork`, and `executeInFork` refuse with `E2B_SECURE_SNAPSHOT_PROFILE_UNAVAILABLE`; no SDK/provider call, snapshot, or child creation is available through those entrypoints, and no live containment property is qualified |
| Daytona and AWS/Firecracker | Research only | No adapter and no production-readiness claim |
| Hosted/MCP/Harness integration | Not production-wired | A disabled-by-default planner injection seam has a real loopback ordering test before `server/discover`, but existing runtime callers do not supply it; no hosted or live interception is enforced |
| Production readiness | **Blocked** | Neither adapter is an approved production isolation boundary, hosted interception is not enabled, and no live traffic is protected |
| Performance and provider cost | Local reference benchmark available | Measures only local protocol mechanics; live MCP/cloud latency, containment, and provider cost remain unmeasured |

The remediated Risk Fork test surface contains 195 tests. On the final local checkout, all 195 passed together with the syntax check, no-network/no-spend self-test, and package dry-run. Pushed-head CI is authoritative only for the exact commit shown on PR #298 and must be checked there; local green results do not establish production readiness.

Run the repository checks for the exact checkout before relying on a source surface:

```powershell
cd risk-fork
npm install
npm test
npm run check
npm run benchmark:local
npm run pack:dry
```

Passing local checks is not proof that a cloud adapter is deployed, that network isolation is effective, or that a provider object was destroyed.

The repository adapter-conformance worker uses a request-correlated result/ACK handshake: the worker holds its terminal exit until the coordinator acknowledges the exact result, and the coordinator accepts the outcome only after ACK delivery completes and the worker exits consistently. This replaces timing-grace behavior; it is process-ordering evidence, not adapter containment evidence.

The production blockers are tracked in [#301 (hosted MCP interception)](https://github.com/rhein1/agoragentic-integrations/issues/301), [#302 (sanitized E2B boot and live qualification)](https://github.com/rhein1/agoragentic-integrations/issues/302), and [#303 (distributed transaction authority)](https://github.com/rhein1/agoragentic-integrations/issues/303).

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
4. Any future production provider must establish network and lifecycle restrictions before the child starts and import only a demonstrably sanitized filesystem payload. The included E2B adapter refuses allocation and execution because no such secure snapshot profile is available.
5. Every child output remains tainted. There is no child-to-parent conversation merge or memory merge.
6. The taint gate may prepare exactly one of:
   - `TYPED_RESULT`
   - `WORKSPACE_DIFF`
   - `CONSEQUENTIAL_ACTION_PROPOSAL`
7. A child consequential-action candidate contains only the proposed action. The clean side creates and attaches the execution binding; the child never receives or returns the authorization reference, hash, nonce, or one-use identifier.
8. The provider is asked to destroy the fork and savepoint; separate verification must establish destruction. Unknown or failed verification remains explicit.
9. A clean controller first performs advisory current-governance and exact-approval preflight. The concrete `FileParentHeadTransaction` then takes its per-parent lock, compares and durably reserves the parent head, reads persisted current governance, reserves the exact one-use approval, validates the artifact, capsule/binding freshness, policy, mandate, budget, provider/target/cost fields, and any clean-side required-test evidence, and invokes the accepted effect while the same lock remains held. Arbitrary host callback authorities and duck-typed transaction substitutes are rejected.
10. A consequential action additionally enters the concrete `FileExecutionAuthorizationTransaction` while the parent lock remains held. That authorization transaction is the sole local revocation and one-use ordering authority. Its trusted verifier proves signature, integrity, and exact binding only; current local authorization state, freshness, revocation, consumption, and execution are ordered under the authorization lock. A claimed-but-unresolved mutation or execution leaves durable ambiguous state and must not be retried automatically. The included file-backed implementations are local single-filesystem protocol/reference durability only, not a distributed production transaction authority.
11. A hash-bound receipt cross-binds lineage, fork/provider, risk decision, artifact, destruction evidence, optional authorization reference, and lifecycle-derived timestamps without embedding authority or raw private content.

## What was reused, extended, and added

| Classification | Primitive | Treatment in Risk Fork |
| --- | --- | --- |
| **REUSE** | Transaction Assurance canonical JSON and `sha256:` reference semantics | Shared hashing keeps evidence references compatible; Transaction Assurance evidence is not treated as authority, certification, or settlement proof |
| **REUSE** | Existing authoritative policy, approval, revocation, credential, and action-execution subsystems | Consumed through clean-side verifier/executor callbacks; Risk Fork does not replace or mint their authority |
| **NEW** | Local file-backed parent-head and execution-authorization transactions | Demonstrates fail-closed, under-lock reference semantics; production needs the durable shared authority tracked in issue #303 |
| **EXTEND** | Transaction Assurance evidence envelopes and receipt linkage | Risk Fork receipts can reference external evidence while explicitly setting settlement/certification claims to false |
| **EXTEND** | Existing governance and exact action binding | Adds fork identity, MCP origin/method, effective arguments, provider, target, amount, policy/mandate/budget refs, versions and hashes, governance epoch, validity window, nonce, audience, and one-use authorization ID to the commit boundary |
| **EXTEND** | Tool interception | Adds a disabled-by-default planning seam before real MCP `server/discover`; hosted wiring and the remaining phase coverage are follow-up work |
| **NEW** | Savepoint Capsule and fresh fork identity | Bounded, content-excluding state contract plus new child identity/entropy namespace |
| **NEW** | Risk classifier, lifecycle, taint gate, clean-commit composition, and Risk Fork receipt | Provider-neutral v1 contracts with fail-closed transitions and explicit unknown states |
| **NEW** | Provider interface and adapters | Local protocol simulator plus an E2B fail-closed safety stub; a secure E2B snapshot profile and other providers remain future qualification work |

## Source surfaces

The package export map exposes the main module plus focused subpaths:

```js
import { classifyRisk } from '@agoragentic/risk-fork/classifier';
import { LocalReferenceRiskForkAdapter } from '@agoragentic/risk-fork/adapters/local-reference';
```

Because the package is source-only and private, the checked-in example imports source files directly. Run it only as a protocol demonstration:

```powershell
node examples/local-reference.mjs
```

The example prepares a typed artifact in an empty disposable workspace, destroys and independently verifies the local copies, and stops before clean commit. It does not contact a provider, spend funds, use credentials, or demonstrate real isolation.

Risk Fork currently reuses the adjacent source checkout at `transaction-assurance/src/canonical.mjs`. Consequently, `npm pack --dry-run` is a contents audit, not proof that the tarball is independently installable outside this monorepo. A future publication tranche must replace that source-relative edge with a resolvable reviewed package dependency before removing `private: true`.

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

Capability flags are declarations that must be independently tested. `supports_verified_destruction: true` does not itself prove an individual resource was destroyed. Production mode requires declared hard TTL, idle TTL, maximum execution-time enforcement, and either prohibited child credentials or automatic credential expiry. Both included adapters declare `supports_idle_ttl: false`, so neither can pass the production gate in this version.

The E2B adapter is dependency-injected and unconditionally fail-closed at its allocation and execution entrypoints. Construction still validates a clean-side `verifyAuthorityFreeSource` function plus reviewed `trustedBootstrapArtifactHash` and `trustedRunnerArtifactHash` values, but supplying those values does not enable provider use. `createSavepoint`, `createFork`, and `executeInFork` throw `E2B_SECURE_SNAPSHOT_PROFILE_UNAVAILABLE` before SDK loading, verification callbacks, or provider I/O. Its capability profile therefore declares snapshot, network, lifecycle, destruction, and containment support false or unverified. The local adapter likewise requires a manifest-bound clean-side verifier before it copies any non-empty source; empty workspaces use an explicit empty-snapshot proof.

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
