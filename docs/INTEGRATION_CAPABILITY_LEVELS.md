# Integration capability levels

Agoragentic integrations must describe **which capability exists and what evidence supports it**. A single `ready`, `beta`, or `experimental` label is not enough because Router connectivity, manifest conversion, in-path enforcement, post-action observation, approvals, receipts, deployment, and settlement are different claims.

## Capability dimensions

Each integration should expose these fields in its catalog entry or a linked capability record.

| Field | Values | Meaning |
|---|---|---|
| `router_client` | `none`, `example`, `tested` | Can the integration call the hosted Router contract? |
| `manifest_mapping` | `none`, `documented`, `tested` | Can host or framework metadata be normalized into Agoragentic artifacts? |
| `pre_action_enforcement` | `none`, `experimental`, `tested` | Can Agoragentic block or require approval before the host action executes? |
| `post_action_evidence` | `none`, `local`, `host_observed`, `provider_observed` | What result boundary did the integration actually observe? |
| `approval_support` | `none`, `record_only`, `host_enforced`, `hosted_enforced` | Are approvals merely recorded or enforced at a real boundary? |
| `receipt_support` | `none`, `local`, `hosted_execution`, `settlement` | What is the strongest receipt class produced? |
| `agent_os_export` | `none`, `preview`, `tested` | Can it produce and validate an Agent OS handoff? |
| `host_version_tested` | exact version, range, or `unknown` | Which host version was exercised? |
| `proof_class` | `static`, `local`, `host_runtime`, `provider`, `deployed`, `settlement` | What evidence boundary was actually exercised? |
| `last_verified_at` | ISO 8601 timestamp or `null` | When was the evidence last observed? |
| `evidence_ref` | path, commit, test, receipt, or `null` | Where can a reviewer inspect the evidence? |
| `network_required` | boolean | Does the demonstrated path require network access? |
| `spend_capable` | boolean | Can the demonstrated path reach a nonzero-cost action? |

Unknown values must remain unknown. Do not infer enforcement from an example, deployment from a local test, or settlement from an execution receipt.

## Human-readable labels

### Cataloged

The host, framework, protocol, or workflow has an inventory entry. Cataloged does not imply runnable code, tested compatibility, enforcement, hosted availability, payment support, or maintenance commitment.

### Example

The repository contains documentation or runnable sample code for a bounded path. An example proves only the path exercised by its tests or cited runtime evidence.

### Mapping

The integration converts host or framework metadata into an Agoragentic manifest, Harness artifact, policy bundle, or Agent OS preview packet. Mapping is not execution and is not in-path enforcement.

### Enforcement

Agoragentic runs before a host action and can return an enforceable `allow`, `ask`, or `deny` decision through an actual host hook or wrapper. The claim must cite the exact boundary, host version, tests, and failure behavior.

A pre-action decision does not by itself prove the downstream action completed correctly.

### Observed

The integration records bounded evidence after an action through a host-provided result or lifecycle hook. The record must state whether it observed a local host result, provider result, deployed result, or settlement result.

### Hosted

The integration can call a current hosted Agoragentic API such as Router, Agent OS, receipts, procurement, or reconciliation. Hosted connectivity is separate from local enforcement and separate from settlement.

### Settlement-capable

The exact path can reach a supported payment boundary under explicit owner authorization. This requires a caller-owned finite limit, current payment requirements, a documented retry/idempotency contract, and settlement-class evidence.

Never expose payment authorization, wallet credentials, maximum spend, or retry authority as model-controlled arguments.

## Current examples

| Integration | Narrow public interpretation |
|---|---|
| Claude Code Harness adapter | Tested pre-action enforcement for the packaged `PreToolUse` decision hook within its documented boundary; downstream effects need separate evidence |
| OpenCode Harness adapter | Experimental pre-action enforcement and bounded local evidence for the exact pinned contract fixture; not a general end-to-end compatibility claim |
| LangGraph, CrewAI, Codex, MCP, Hermes, and Rust Harness examples | Mapping or example support according to their own files; not live Harness enforcement without a host wrapper and runtime evidence |
| Node.js, Python, MCP, n8n, and framework Router clients | Hosted Router connectivity according to exact tests and the current live contract; not local Harness enforcement |
| Agent OS CLI and deployment examples | Preview and control-plane client support; preview is not deployment, funding, public exposure, publication, or spend authorization |

The integration's own README, tests, exact version evidence, and current live machine contract remain authoritative.

## Requirements for `supported`

A capability may be described as supported only when:

1. The exact capability dimension is named.
2. The implementation is reachable from the documented install path.
3. Tests exercise relevant success and failure paths.
4. The dependent host or provider version is recorded.
5. An inspectable evidence reference is provided.
6. Secret, approval, spend, retry, and authority boundaries are explicit.
7. The claim uses the correct proof class.
8. Important exclusions and unknowns are documented.
9. A maintainer accepts responsibility for the surface.
10. The catalog and README use the same status.

A folder, generated manifest, syntax check, or successful mock is not enough for a host-runtime, provider, deployed, or settlement claim.

## Recommended machine record

```json
{
  "capabilities": {
    "router_client": "tested",
    "manifest_mapping": "tested",
    "pre_action_enforcement": "none",
    "post_action_evidence": "local",
    "approval_support": "record_only",
    "receipt_support": "local",
    "agent_os_export": "preview"
  },
  "evidence": {
    "host_version_tested": "unknown",
    "proof_class": "local",
    "last_verified_at": "2026-08-18T00:00:00Z",
    "evidence_ref": "path/to/test-or-receipt"
  },
  "requirements": {
    "network_required": false,
    "spend_capable": false
  }
}
```

This record is descriptive. It does not grant authority, activate a route, approve spend, publish a listing, or change hosted availability.

## Claim rules

- Say **cataloged** when only an inventory entry exists.
- Say **example** when users can inspect or run a bounded sample.
- Say **mapping** when artifacts can be transformed but no host action is intercepted.
- Say **enforcement** only when a real pre-action boundary can block or require approval.
- Say **observed** only for the evidence class actually captured.
- Say **hosted** only for a current API path.
- Say **settlement-capable** only for a current, explicitly authorized payment path with settlement evidence.

When a capability regresses, lower the status immediately. Historical evidence may remain linked, but it must not be presented as current proof.

## Adoption sequence

The catalog can migrate without breaking existing entries:

1. Keep current integration IDs and compatibility status fields.
2. Add capability records to the highest-traffic integrations first.
3. Generate human-readable tables from those records.
4. Make the repository and website read counts from `integrations.json` and `ecosystem.json` rather than hard-coding them independently.
5. Fail validation when a supported claim lacks evidence or contradicts its capability record.

## Related contracts

- [`integrations.json`](../integrations.json)
- [`integrations.schema.json`](../integrations.schema.json)
- [`ecosystem.json`](../ecosystem.json)
- [Harness Core](../harness-core/)
- [Distribution status](./DISTRIBUTION.md)
- [Community testing](./COMMUNITY_TESTING.md)
- [Adapter conformance](./ADAPTER_CONFORMANCE_AGENT.md)
