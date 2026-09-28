# OpenShell integration scaffold

**Source-only, offline, default-off. No OpenShell installation, gateway connection, sandbox provisioning, agent execution, package publication, or production activation is performed.** This is a preparation surface under the existing Agent OS examples, not a new supported integration or canonical tool ID.

Agoragentic owns owner mandates, action approvals, identity, budgets, receipts, and reconciliation. OpenShell is a candidate execution-isolation layer underneath those controls. A sandbox policy must not grant payment, federation, publication, or trust authority.

## Run the implemented scaffold

Node.js 20+; no package installation or credentials required. From the repository root:

```sh
node --test agent-os/openshell/scaffold.test.mjs
node agent-os/openshell/preview.mjs agent-os/openshell/fixture.json
node agent-os/openshell/preview.mjs --readiness
```

The fixture uses a **fictional image digest and example hostname**. It demonstrates the format, not an image that can be pulled or a live discovery target. The readiness command describes this scaffold only; it does not inspect a host. `activationSupported` remains false. There is no `apply` command or enabling environment variable.

## What is implemented

- A deterministic policy/plan compiler with strict input validation, bounded input, immutable output, and SHA-256 plan/policy digests.
- Separate Cartographer, Emissary, and Steward profiles. Cartographer can propose exact-host/exact-path HTTPS GET/HEAD egress. Emissary and Steward remain network-denied. All profiles are proposal-only.
- A TypeScript SDK `createSpec` candidate with create-time filesystem, process, hard-required Landlock, explicit L7 enforcement, no provider attachment, no environment injection, and no exposed service ports.
- An adapter preparation interface whose invocation path always refuses activation.
- Offline observation shaping that requires a terminal integer exit code, binds an expected sandbox ID, distinguishes pending deletion, and never upgrades caller reports to verified receipts.
- A pinned upstream source record and a staged integration/qualification handoff.

```js
import { OpenShellScaffoldAdapter } from './scaffold.mjs';
const adapter = new OpenShellScaffoldAdapter();
const plan = adapter.prepare(request); // pure local compilation
// await adapter.invoke(...);          // always refuses; no live driver is bound
```

## Role boundaries

| Role | Current proposal | Later host integration, not implemented here |
|---|---|---|
| Cartographer | Explicit public read candidates; no default egress | Observe approved sources, retain provenance, emit discovery candidates without promoting trust |
| Emissary | Offline drafting, no egress or credentials | Submit bounded contact proposals to the existing consent/mandate-controlled host path |
| Steward | Offline evidence review, no egress or mutation | Recommend maintenance and policy changes; owner gates remain outside the sandbox |

This preserves agent-operated growth and maintenance without letting the agents approve their own authority expansion. These profiles do not contain or start the actual role agents. The only candidate create-time command is `/bin/true`; replacing it with a role worker is a separate reviewed change.

## Upstream contract and important details

Reviewed target: **OpenShell v0.1.2**, commit `6648bd0c290efbc41ba131ee9831ee45cd431f94`. See [upstream.lock.json](upstream.lock.json) for file/blob provenance and review scope. No upstream source is vendored. Runtime compatibility remains untested.

Primary sources at that immutable revision:

- [TypeScript SDK interface and distribution](https://github.com/NVIDIA/OpenShell/blob/6648bd0c290efbc41ba131ee9831ee45cd431f94/sdk/typescript/README.md)
- [SDK create/exec/deletion types](https://github.com/NVIDIA/OpenShell/blob/6648bd0c290efbc41ba131ee9831ee45cd431f94/sdk/typescript/src/client.ts)
- [Policy protobuf contract](https://github.com/NVIDIA/OpenShell/blob/6648bd0c290efbc41ba131ee9831ee45cd431f94/proto/sandbox.proto)

`createSpec` uses **camelCase SDK message-init fields**, not CLI YAML. The policy protobuf specifies audit as the unspecified inspected-network enforcement mode; this compiler sets `enforcement: 1` explicitly. `tls: 0` is automatic TLS handling, not TLS bypass. The proposal has no `allowedIps`, uninspected-credential bypass, provider attachment, middleware registration, or `rawSpec` escape hatch.

OpenShell filesystem/process/Landlock policy must be supplied at creation; sandbox-scoped policy updates cannot introduce static fields later. The proposed image must have the non-root `sandbox` account, `/bin/true`, `/usr/bin/curl`, required runtime paths, `/sandbox/input`, and `/sandbox/output`. None of those image properties are verified by a digest-shaped string.

The SDK is documented as distributed through GitHub Packages at this release. Do not assume an identically named public npm package is the reviewed build. A later approved setup must authenticate outside the sandbox, pin SDK and gateway versions together, and record package/image integrity. Do not run an unpinned remote installation script as part of this scaffold.

## Evidence and safety limits

A local `planDigest` or `policyDigest` is **not** an OpenShell protobuf policy hash, signature, owner approval, attestation, settlement receipt, or proof of work. The digests bind the scaffold's canonical local JSON. Plan validation detects changes against this compiler; it does not authenticate who proposed the plan.

Observation summaries accept only the small documented projection (`kind`, `sandboxId`, and `exitCode` or `outcome`). Do not feed raw SDK objects, stdout, stderr, prompts, environment variables, credentials, or customer data into them. Output remains `caller_reported_unverified` even when an exit code is zero. A deletion result of `accepted` is pending, not cleanup success. Missing or replaced sandbox identity must not be papered over by inserting an expected ID into a response that did not contain it.

Hostname screening is syntactic only. It does not resolve DNS or establish SSRF protection, consent, endpoint semantics, redirect safety, or trust. GET/HEAD does not guarantee a remote application is side-effect-free. The host must validate destinations at connection time, control redirects, and test metadata/private-network denial. No real request is made here.

The runtime deadline is a **host requirement, not an implemented timer**. All runtime-verification flags stay false. CPU/memory/storage quotas, lifecycle cancellation, tenant isolation, gateway identity/authentication, effective policy confirmation, and independent containment evidence remain qualification work. No Docker socket, host credentials, gateway admin token, signer, wallet key, or production database belongs in the worker image or mounts.

## Integration ownership and next work

See [CODEX_HANDOFF.md](CODEX_HANDOFF.md). Keep the reusable compiler here; host authority wiring belongs in the platform, while Harness Core should consume only a supported local evidence/proposal interface. Do not create another Harness Core implementation in this repository's migration-pointer directory. Risk Fork/ECF checks are additional gates, not reasons to skip sandbox or owner controls.

No changes to the canonical integration index, integration counts, paid execution, custody state, trust vocabulary, public readiness claims, or existing runtime selection are made by this scaffold.
