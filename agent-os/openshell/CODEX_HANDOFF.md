# OpenShell augmentation and integration handoff

## Goal and present state

Integrate OpenShell below Agoragentic's existing control plane, preserving the agent-operated Interchange and all owner, financial, identity, trust, and evidence boundaries. The compiler, offline CLI, observation shaper, offline lifecycle reconciler, synthetic failure tests, and source pin are implemented. A live provider adapter is **not** implemented or qualified. No production migration is authorized by this document.

## Work sequence

### 1. Source and build qualification

Re-read repository instructions and the pinned upstream contracts. Resolve the v0.1.2 release to the recorded commit; verify the SDK package and gateway build rather than trusting a version string. Install only in an owner-approved disposable lab. Verify the generated SDK types accept `createSpec` and verify server-side normalization has not weakened its policy. Upgrade the pin only in a reviewed change that updates the lock and conformance fixtures together.

Build or select a digest-pinned minimal worker image with the `sandbox` user/group, explicitly required paths and binaries, no credentials, no host-runtime socket, and no production configuration. The example digest is fictional. Validate hard-required Landlock on the actual host. Failure must stop setup, not silently downgrade to best effort.

Acceptance: recorded package/image/gateway integrity, generated type/schema checks, policy acceptance, and a reproducible host/image definition. These are not yet containment proof.

### 2. Trusted host adapter

The integrations repository contains offline lifecycle reconciliation in `host-adapter.mjs`; it is not a live provider, SDK shim, or authority boundary. It validates bounded journal events and preserves unresolved identity, execution, and cleanup states without provider, process, or network effects. A future implementation in the existing platform provider abstraction must first bind to the real server-owned mandate, consent, identity, budget, and provisioning approval boundary; no caller-supplied object may stand in for that authority. `OpenShellClient.connect()` is lazy: a successful construction is not a health check. Require a real `health()` result and verified gateway identity/auth configuration.

Bind authorization outside the sandbox to the exact owner, tenant/workspace, run, immutable sandbox ID, compiled plan/policy digest, image digest, command, quota, and expiry. Recheck the financial freeze and relevant mandate/consent controls. A caller-supplied `approved: true`, environment flag, self-hash, fake SDK client, or policy advisor proposal is not authorization. Do not accept agent-supplied method names, deployment contracts, policy overrides, `rawSpec`, provider lists, or arbitrary environment variables.

Use the pinned SDK's `sandbox.create`, `waitReady`, `getConfig`, `exec`/`execStream`, `delete`, and identity-aware `waitDeleted` interfaces only after rechecking their actual types. Confirm effective static and network policy before any worker executes. Keep request data and authority/control-plane clients in separate trust domains.

Acceptance for this source tranche: local tests exercise complete and interrupted journals, ambiguous create and late identity, cancellation/revocation/timeouts, missing terminal codes, wrong sandbox identity, config mismatch, pending/unknown deletion, invalid ordering, replay, and bounded strict input. Reconciliation never synthesizes success, authorizes retries, or converts caller observations into verified evidence. Live invocation remains hard-off. This does not establish a real host gate, gateway health, or runtime containment.

### 3. Bounded lab canary and failure cleanup

Obtain separate owner approval for lab resources; no payment/custody enablement follows. Start with the fixed `/bin/true` canary, then a reviewed read-only worker. Enforce CPU, memory, storage, wall-clock, and output limits in the actual host/runtime, not just metadata.

Test an approved read succeeds and unapproved hosts/methods/paths, private IPs, cloud metadata, redirects/rebinding, unauthorized files, credential reads, provider attachment, policy widening, and cross-workspace access fail. Use synthetic secrets only. Capture policy identity, sandbox identity, image/build identity, terminal status, and independently observed denials without raw sensitive logs. A network error alone is not proof that a policy denial occurred.

Test create failure, timeout, cancellation, stream closure without terminal exit, gateway failure, policy drift, owner revocation, interrupted cleanup, and same-name sandbox replacement. Ambiguous create/exec responses are not safe to retry automatically. Track sandbox IDs durably so an orphan can be reconciled. `accepted` deletion stays pending; `unspecified`/unknown stays unknown. Abort of a client RPC is not proof the worker stopped. Verify termination/cleanup separately.

Acceptance: authenticated, identity-bound live evidence for success, denials, and cleanup. Keep production and live-traffic qualification false until independently reviewed.

### 4. Role integration, in order

Cartographer first: supply only sanitized public-source inputs from the existing owner-approved source configuration. Preserve discovery provenance and quotas; no new trust, listing, peer-key, payment, or wallet mutation. Candidates discovered by an agent are not automatically approved egress destinations.

Emissary second: isolate drafting/inspection. Send contact proposals to the existing host consent/mandate path; do not move sender credentials, key-pinning authority, or transport approval into the worker. Retain first-contact limits and independent owner gates.

Steward third: consume minimal evidence references and propose bounded maintenance. Do not let it approve its own policy changes, reconfigure the gateway, grant credentials, or merge/deploy itself. Put approval and policy application in separate host components.

Harness Core/ECF: connect through existing proposal/evidence contracts. Mark imported artifacts as local/unverified until a trusted evidence verifier promotes them. Never treat local plan hashes as portable authority. Risk Fork can evaluate candidate changes, but it is not a substitute for OpenShell containment or the owner's mandate.

### 5. OpenShell-specific augmentation, after baseline qualification

Evaluate supervisor middleware for pre-action checks and gateway interceptors for control-plane admission. First inspect the pinned upstream contracts and failure behavior. Keep policy admission fail-closed; do not assume extension existence supplies authenticated Agoragentic authority. Policy advisor/prover output can explain proposed access changes but must remain a recommendation until the independent host approval path authorizes the exact delta. Formal policy reasoning is not business-consent or settlement verification.

Credential-backed inference/provider routes require a separate approved threat model and endpoint-scoped credential binding. Do not export signer/custody material. Any paid inference or external resource cost requires its own authorized budget. No generic provider attachment or arbitrary network widening is allowed.

Acceptance: isolated integration tests for unavailable/bypassed middleware, expired/replayed approvals, widened policy, and non-mutating denied requests. No production claims based only on source inspection.

## Completion report required from the implementation agent

Report changed files, source/SDK/image/gateway pins, actual test commands and outcomes, evidence provenance, enabled versus default-off paths, outstanding gates, rollback/cleanup status, and the final reviewed commit. Separate local tests, mocked contract tests, live canaries, and production verification. Do not claim subagent review unless real subagent execution was available.

Rollback before activation is simply leaving the provider unselected. After an approved lab activation, stop new dispatch, revoke the lab grant, terminate only the recorded sandbox IDs, verify cleanup, and preserve redacted evidence. Never delete another workspace's or a same-name replacement's resource.
