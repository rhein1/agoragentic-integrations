# Agoragentic Prime Agent integration

Put a bounded Agoragentic authority, policy, evidence, and Agent OS runtime-contract boundary around Prime Agent.

```text
Prime Agent session
→ classify proposed tool call
→ allow / interactive review / deny
→ observe redacted result evidence
→ produce a clearly labeled local receipt

Agent OS runtime request
→ exact Prime Agent host pin
→ closed request and plan contract
→ validate plan and evidence hashes
→ remain no-spawn, no-network, no-spend, and no-authority
```

## Package surfaces

The source package exposes two separate surfaces:

- `@agoragentic/prime-agent` — Prime Agent extension entry point for lifecycle/tool governance;
- `@agoragentic/prime-agent/runtime-contract` — Agent OS request builder plus runtime plan, evidence, and compatibility-packet validators.

The separation is intentional. The extension governs events visible to Prime Agent. The runtime contract validates the external Agent OS boundary. Neither surface turns Prime Agent's worker or IPython process into a security sandbox.

## Extension capabilities

The extension implements:

- Prime Agent lifecycle registration for session, agent, tool, compaction, and shutdown events;
- conservative read/write/network/spend/deploy/publish/trust classification, including `ipython` `input.code`;
- exact principal, agent, session, tool-call, capability, and input-hash binding for high-impact actions;
- mandatory synchronous verification by a host-trusted principal-authority verifier;
- one-time consumption of authority IDs and action hashes to reject local replay;
- fail-closed behavior when authority or interactive review is unavailable;
- proposal-only authority requests with a maximum 15-minute lifetime;
- bounded redaction and hash-based evidence;
- `/agora-status` and `agoragentic_status` read-only surfaces;
- local receipts that explicitly are not settlement, certification, trust endorsement, or marketplace verification.

Local policy allowlists and interactive confirmation cannot authorize spend, deploy, publish, or trust actions. Those actions require an active exact grant plus a trusted verifier supplied by the host. Unknown IPython code also fails closed.

## Agent OS runtime integration

Build a normalized preview request without provider credentials or live network configuration:

```js
import {
  buildPrimeAgentRuntimeRequest,
  buildPrimeAgentIntegrationDescriptor,
} from '@agoragentic/prime-agent/runtime-contract';

const request = buildPrimeAgentRuntimeRequest({
  owner_id: 'owner-123',
  workspace_id: 'workspace-123',
  deployment_id: 'deployment-123',
  principal_ref: 'principal:owner-123',
  goal: 'Audit this repository and return evidence.',
  sandbox_profile_ref: 'sandbox:agent-os-restricted-v1',
  harness_policy_ref: 'policy:prime-agent-v1',
  authority_ref: 'authority:prime-agent-v1',
  model_ref: 'model:gpt-5.6',
  provider_ref: 'provider:openai',
  credential_profile_ref: 'credential-profile:prime-agent-v1',
  runtime_image_ref: 'image:prime-agent-v0.7.1-restricted',
  runtime_image_digest: 'sha256:<64 lowercase hex characters>',
  extension_integrity_ref: 'sha256:<64 lowercase hex characters>',
});

console.log(buildPrimeAgentIntegrationDescriptor());
console.log(request);
```

The request defaults to the opaque MCP profile `mcp-profile:agoragentic-private-v1`. The future executor resolves that profile under owner policy; the request never carries a bearer token or live credential.

Validate the Agent OS response before using it as evidence:

```js
import {
  buildPrimeAgentCompatibilityPacket,
  validatePrimeAgentRuntimePlan,
  validatePrimeAgentRuntimeEvidence,
} from '@agoragentic/prime-agent/runtime-contract';

const planValidation = validatePrimeAgentRuntimePlan(plan);
if (!planValidation.valid) throw new Error(planValidation.blockers.join(', '));

const evidenceValidation = validatePrimeAgentRuntimeEvidence(evidence, plan);
if (!evidenceValidation.valid) throw new Error(evidenceValidation.blockers.join(', '));

const compatibility = buildPrimeAgentCompatibilityPacket({ plan, evidence });
```

`contract_compatible` means the source package, host pin, closed plan shape, plan hash, and closed zero-action evidence agree. The plan must retain `launch_allowed:false`, `runtime_executed:false`, `no_spawn:true`, `no_network:true`, `no_spend:true`, and `authority_granted:false`. Undeclared credential, authority, payment, settlement, wallet, or provider-output fields block compatibility even when a caller recomputes the object hash. It does not mean a Prime Agent process ran or that production compatibility was verified.

See [RUNTIME_INTEGRATION.md](RUNTIME_INTEGRATION.md) for the full contract, activation gates, and exact evidence checklist for a separately authorized future restricted Linux executor.

## Prime Agent v0.7.1 contract

The package metadata and deterministic fixture target Prime Agent `v0.7.1` at commit `95afd319a78ae017a41241d50b013d656a0685ce`:

- the root package declares `pi.extensions: ["./index.mjs"]` and the `pi-package` keyword;
- the Node.js floor matches Prime Agent's `>=22.8.0` engine;
- session fixtures use `type`, `reason`, and optional `previousSessionFile`;
- tool fixtures use `type`, `toolCallId`, `toolName`, and `input.code` for IPython;
- the runtime contract pins RPC mode and LF-delimited JSONL framing.

Install or test the local package with Prime Agent's package path shape:

```bash
prime-agent package install ./prime-agent-governance
prime-agent -e ./prime-agent-governance
```

The default extension export has no authority provider and therefore denies every high-impact call. A host wrapper that enables such calls must instantiate `createAgoragenticPrimeExtension()` with trusted principal, agent, and session refs; an action-time `resolveAuthority` callback; a synchronous `verifyAuthority` callback; and a durable replay guard outside the process.

## Local validation

From this directory:

```bash
npm run check
npm test
npm run pack:dry
```

From the repository root:

```bash
node --test test/integration-inventory-holds.test.mjs
node scripts/verify-integrations-json.js
```

The package remains source-only and absent from the public integration list. Its centrally owned, expiring inventory hold lives in `integrations.json`; package-local files cannot grant or extend that hold.

## Hard boundary

Prime Agent executes model-generated Python and project commands with the user's operating-system permissions. Its daemon, workers, and kernels improve lifecycle containment, not security isolation. Static classification cannot prove that every nested Python side effect was observed.

Payment-bearing or production use requires a restricted Agent OS lane with externally enforced network, filesystem, process, credential, and payment chokepoints; owner stop/revoke; idempotent mutation handling; uncertain-effect reconciliation; evidence-gated child completion; and Transaction Assurance.

No partnership or end-to-end runtime compatibility claim is made until an external Prime Agent host run is reviewed and the central inventory hold is deliberately removed.
