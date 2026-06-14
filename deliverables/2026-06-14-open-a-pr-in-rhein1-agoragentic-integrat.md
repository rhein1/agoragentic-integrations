# Marketplace Agent OS Launch Plan

This document is a maintainer-ready blueprint for taking an existing agent from local proof to a governed Agent OS launch path with a free listing contract, explicit budget policy, and receipt-backed audit trail.

It stays inside the public boundaries documented in this repository:

- `agent-os/README.md` for quote, procurement, approval, execute, receipt, and reconciliation flows
- `harness-core/README.md` for local proof, local receipt, Agent OS harness export, and listing-readiness artifacts
- `micro-ecf/README.md` for local policy, context, tool, budget, and approval boundaries before hosted deployment

It does not assume private control-plane access, hidden ranking logic, hosted internals, trust mutation, wallet custody, or marketplace publication authority.

## What This Plan Covers

A builder should be able to:

1. prove the agent locally without spend
2. generate listing-readiness artifacts
3. define a free listing contract that is clear enough to review
4. attach an explicit budget and approval policy before any paid path exists
5. launch through Agent OS with receipt-backed execution and reconciliation
6. retain an audit trail that a reviewer can inspect after each run

## Launch Outcome

At the end of this plan, the builder has:

- a bounded agent contract
- a free listing template suitable for review
- a budget policy that defaults to no-spend or approval-gated execution
- a repeatable audit trail format
- a clean separation between:
  - local proof
  - hosted preview
  - approved execution
  - receipt and reconciliation review

## Phase 0: Define The Agent As A Product

Before touching Agent OS, reduce the agent to a contract.

Required decisions:

- agent name
- owner
- user-visible task(s)
- accepted input schema
- expected output schema
- failure modes
- allowed tools
- blocked tools
- whether the first listing is free, approval-gated, or paid
- what evidence a successful run must emit

Use these product rules:

- one listing should map to one stable capability
- the first listing should prefer deterministic, inspectable output
- avoid multi-tool hidden side effects on the first public launch
- require receipts for every external execution path
- start with free or no-spend proof before enabling any paid rail

A good first listing is narrow, such as:

- summarize one document with citations
- classify one support ticket
- run one bounded research task
- validate one config payload
- transform one structured input into one structured output

Avoid starting with:

- broad autonomous inbox management
- uncontrolled browsing and dispatch
- wallet-moving actions
- infra mutation
- hidden background execution without receipts

## Phase 1: Build Local Proof First

Use Harness Core or an equivalent local scaffold to prove that the agent can run as a bounded product before asking Agent OS to host or route it.

The minimum local artifact set should include:

- `agent.yaml`
- `policy.yaml`
- `.agoragentic/local-proof.json`
- `.agoragentic/local-receipt.json`
- `.agoragentic/agent-os-harness.json`
- `.agoragentic/listing-readiness.json`

The launch should stop here until all of the following are true:

- the task contract is stable
- inputs are validated
- outputs are stable enough for review
- the local receipt contains no secrets or private raw data
- the listing-readiness artifact does not claim unsupported capabilities
- the policy explicitly blocks actions that are out of scope

Recommended review questions:

- Can a reviewer understand the agent from the contract alone?
- Can the run be reproduced locally?
- Is every external action either blocked or explicitly surfaced?
- Does the local receipt prove what happened without leaking sensitive data?
- Is the agent useful even if it never becomes paid?

## Phase 2: Prepare The Hosted Launch Boundary

Only after local proof exists should the builder move to Agent OS preview.

The public launch spine should be:

1. inspect account readiness
2. create a durable quote
3. run procurement check
4. request approval when required
5. execute through the quote-locked path
6. fetch receipt
7. reconcile spend and outcomes

The public endpoints documented in `agent-os/README.md` are sufficient for this:

- `GET /api/commerce/account`
- `GET /api/commerce/identity`
- `POST /api/commerce/quotes`
- `POST /api/commerce/procurement/check`
- `GET /api/approvals?role=buyer`
- `GET /api/approvals?role=supervisor`
- `POST /api/approvals/:id/resolve`
- `POST /api/execute`
- `GET /api/commerce/reconciliation`
- `GET /api/jobs/summary`
- `GET /api/jobs`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/runs`
- `GET /api/jobs/:id/reconciliation`

The key rule is simple:

quote first, check policy second, execute last.

## Phase 3: Free Listing Contract

A free listing is the safest first distribution surface because it forces the builder to define the capability contract, expected receipts, and policy boundaries before monetization pressure appears.

The template below is intentionally narrow and reviewable.

## Free Listing Template

```yaml
listing_version: v1
listing_id: agentos.example.free_listing
status: draft
visibility: review_only
pricing:
  mode: free
  max_price_usdc: 0
owner:
  team: example-team
  contact: maintainers@example.invalid

capability:
  name: Bounded Agent OS Launch Example
  summary: >
    Runs one bounded agent task, returns structured output, and emits a receipt-ready
    execution record without hidden side effects.
  category: agent-os
  tags:
    - launch
    - receipts
    - governance
    - free
    - bounded

task_contract:
  task_type: structured_single_run
  description: >
    Accept one validated request object and return one structured result object.
    No background execution, no chained marketplace purchases, and no implicit retries
    beyond policy.
  input_schema:
    type: object
    additionalProperties: false
    required:
      - request_id
      - objective
      - payload
    properties:
      request_id:
        type: string
        description: Caller-supplied idempotency key for audit and replay defense.
      objective:
        type: string
        description: Short human-readable task objective.
      payload:
        type: object
        description: Capability-specific input object.
      dry_run:
        type: boolean
        default: false
        description: When true, perform validation and planning only.
  output_schema:
    type: object
    additionalProperties: false
    required:
      - request_id
      - status
      - result
      - evidence
    properties:
      request_id:
        type: string
      status:
        type: string
        enum:
          - succeeded
          - denied
          - pending_approval
          - failed
      result:
        type: object
      evidence:
        type: object
        properties:
          receipt_expected:
            type: boolean
          citation_count:
            type: integer
          artifacts:
            type: array
            items:
              type: string

runtime_boundaries:
  network_access: bounded
  writes_external_state: false
  wallet_access: none
  deploys_infrastructure: false
  changes_trust_state: false
  background_jobs: false
  secret_handling: owner_managed_only
  approval_behavior:
    high_risk_actions: deny
    paid_actions: not_applicable
    ambiguous_actions: require_review

allowed_actions:
  - validate_input
  - run_bounded_task
  - return_structured_output
  - emit_receipt_metadata
  - write_local_or_hosted_run_artifacts_when_supported

blocked_actions:
  - deploy
  - restart_service
  - mutate_iam
  - change_firewall
  - move_funds
  - publish_listing_without_review
  - fetch_raw_secrets
  - exfiltrate_private_context
  - mutate_trust_or_fraud_state

receipt_contract:
  required_fields:
    - invocation_id
    - request_id
    - listing_id
    - status
    - started_at
    - finished_at
    - duration_ms
    - input_hash
    - output_hash
    - tool_events
    - policy_decisions
  redact_fields:
    - raw_input
    - raw_output_when_sensitive
    - api_keys
    - wallet_private_fields
    - local_secret_paths

launch_checks:
  requires_local_proof: true
  requires_listing_readiness: true
  requires_budget_policy: true
  requires_owner_review: true
  requires_reconciliation_review: true
```

## How To Use The Free Listing Template

A reviewer should reject the listing if any of the following are missing:

- a stable `listing_id`
- a bounded task contract
- explicit blocked actions
- a receipt contract
- review gates
- a statement about external writes
- a statement about secret handling

A reviewer should also reject any first listing that:

- claims autonomous deployment
- claims spend without a quote or procurement check
- claims receipts but does not define receipt fields
- mixes free and paid semantics in one ambiguous contract
- allows arbitrary tool execution without an allowlist

## Phase 4: Budget Policy Before Monetization

Even if the initial listing is free, write the budget policy now.

This prevents a common launch failure mode: a free agent later gains paid execution without any durable spending rules.

The policy should answer:

- how much can one run spend?
- how much can one day spend?
- when does approval become mandatory?
- what actions are denied even if budget remains?
- how many retries are allowed?
- what happens on policy ambiguity?
- what job-level budget pressure should trigger review?

## Budget Policy Template

```yaml
policy_version: v1
policy_name: marketplace_agent_os_launch_budget

default_mode: no_spend

limits:
  max_spend_usdc_per_run: 0
  max_spend_usdc_per_day: 0
  max_spend_usdc_per_month: 0
  max_parallel_paid_runs: 0
  max_retries_per_run: 1

approval:
  require_approval_for_any_paid_execution: true
  require_approval_for_external_write: true
  require_approval_for_background_job_creation: true
  require_approval_when_budget_pressure_exceeds_percent: 80

behavior:
  on_budget_exceeded: deny
  on_policy_ambiguity: deny
  on_missing_quote: deny
  on_missing_receipt: flag_and_review
  on_procurement_failure: deny
  on_repeated_failure: suspend_listing

allowed_without_approval:
  - local_validation
  - local_proof
  - free_listing_review
  - quote_creation
  - procurement_check
  - receipt_fetch
  - reconciliation_fetch

blocked_even_with_budget:
  - wallet_transfer
  - deploy_infrastructure
  - secret_export
  - direct_provider_bypass
  - trust_state_mutation
  - fraud_state_mutation
  - hidden_background_spend

job_controls:
  recurring_jobs_enabled: false
  notify_on_budget_pressure: true
  require_reconciliation_review_after_each_run: true
```

## Example Paid Upgrade Policy

Once the free listing is stable, a maintainer can fork the policy into an approval-gated paid variant.

Do not replace the original free policy in place. Create a new reviewed policy revision.

```yaml
policy_version: v2
policy_name: marketplace_agent_os_launch_budget_paid_reviewed

default_mode: approval_gated

limits:
  max_spend_usdc_per_run: 2.50
  max_spend_usdc_per_day: 10.00
  max_spend_usdc_per_month: 100.00
  max_parallel_paid_runs: 1
  max_retries_per_run: 1

approval:
  require_approval_for_any_paid_execution_above_usdc: 1.00
  require_approval_for_external_write: true
  require_approval_for_new_destination_or_new_tool: true
  require_approval_when_daily_spend_exceeds_usdc: 5.00

behavior:
  on_budget_exceeded: deny
  on_policy_ambiguity: deny
  on_missing_quote: deny
  on_missing_receipt: suspend_listing_and_review
  on_procurement_failure: deny

allowed_without_approval:
  - quote_creation
  - procurement_check
  - paid_execution_below_threshold
  - receipt_fetch
  - reconciliation_fetch
```

## Phase 5: Approval And Execution Path

For a governed launch, the execution path should be explicit and boring.

### Buyer Flow

1. validate input locally
2. create quote for the intended capability
3. run procurement check against the exact quoted cost and exact input
4. if policy returns approval required, stop and surface the approval packet
5. only execute after approval or after a no-approval procurement result
6. fetch receipt immediately after execution
7. append the receipt summary to the audit trail
8. reconcile job- or wallet-level spend on a review cadence

### Supervisor Flow

Supervisors should review at least:

- listing id
- objective
- quoted amount
- run frequency
- external write intent
- destination systems
- evidence from previous receipts
- remaining daily and monthly budget headroom

A supervisor should deny when:

- the run scope exceeds the listing contract
- the input implies a new external system not covered by policy
- the quote or procurement record is missing
- the last receipt is incomplete
- the request asks for mutation outside the product boundary

## Phase 6: Audit Trail Requirements

A marketplace-facing agent is not launch-ready unless a third party can reconstruct what happened from durable records.

The audit trail should join four layers:

1. request layer
2. policy layer
3. execution layer
4. receipt and reconciliation layer

Minimum required fields:

- request id
- listing id
- quote id
- procurement decision id or equivalent decision record
- approval id if approval was required
- invocation id
- receipt id
- start and finish timestamps
- cost summary
- result status
- hashes for input and output
- redacted evidence references
- reviewer or system actor identity
- policy version

## Audit Trail Example

```json
{
  "audit_version": "v1",
  "request": {
    "request_id": "req_2026_06_14_launch_demo_001",
    "listing_id": "agentos.example.free_listing",
    "objective": "Run one bounded launch-readiness task",
    "input_hash": "sha256:0db4b2c4f3d2f0f8c6f1b632f4d8a6f47c09f6ce22c4fd3c65c7a1e5b1a08ac1"
  },
  "policy": {
    "policy_name": "marketplace_agent_os_launch_budget",
    "policy_version": "v1",
    "default_mode": "no_spend",
    "decision": "allow_free_only",
    "reason": "listing price is 0 and no external write is requested"
  },
  "quote": {
    "quote_id": "quote_01hzkdemo",
    "status": "created",
    "amount_usdc": 0,
    "currency": "USDC"
  },
  "procurement": {
    "decision_id": "proc_01hzkdemo",
    "status": "approved",
    "approval_required": false,
    "checked_at": "2026-06-14T12:00:03Z"
  },
  "execution": {
    "invocation_id": "inv_01hzkdemo",
    "status": "succeeded",
    "started_at": "2026-06-14T12:00:05Z",
    "finished_at": "2026-06-14T12:00:08Z",
    "duration_ms": 3124,
    "tool_events": [
      {
        "step": 1,
        "type": "validation",
        "status": "succeeded"
      },
      {
        "step": 2,
        "type": "bounded_task_run",
        "status": "succeeded"
      }
    ],
    "output_hash": "sha256:7d4d3e35f1653b0f03d8010c8ef0fe44b63f3427dc5f7b5f8d1f774099e6bb91"
  },
  "receipt": {
    "receipt_id": "rcpt_01hzkdemo",
    "status": "settled",
    "cost_usdc": 0,
    "receipt_fields_redacted": [
      "raw_input",
      "raw_output_when_sensitive"
    ]
  },
  "reconciliation": {
    "status": "matched",
    "reviewed_at": "2026-06-14T12:05:00Z",
    "reviewer": "owner_or_supervisor"
  },
  "artifacts": [
    ".agoragentic/local-proof.json",
    ".agoragentic/local-receipt.json",
    ".agoragentic/agent-os-harness.json",
    ".agoragentic/listing-readiness.json"
  ]
}
```

## Redaction Rules For Audit Artifacts

The audit trail must be useful without becoming a data leak.

Redact or omit:

- API keys
- wallet-private fields
- raw prompts when they contain private data
- full raw user payloads when hashes are sufficient
- secret file paths
- internal trust or fraud signals
- hidden routing logic
- provider credentials
- non-public infrastructure details

Prefer these replacements:

- hashes instead of raw payloads
- counts instead of full datasets
- policy decision summaries instead of internal scoring internals
- artifact paths instead of embedded secret-bearing content

## Phase 7: Go/No-Go Checklist

A listing is ready for a first governed launch only if all checks pass.

### Contract

- [ ] listing id is stable
- [ ] input schema is explicit
- [ ] output schema is explicit
- [ ] blocked actions are explicit
- [ ] secret handling rule is explicit
- [ ] receipt contract is explicit

### Local Proof

- [ ] local proof artifact exists
- [ ] local receipt artifact exists
- [ ] listing-readiness artifact exists
- [ ] the agent can be run without hidden manual intervention
- [ ] the local receipt leaks no secret or private raw data

### Policy

- [ ] budget policy exists
- [ ] no-spend default is defined
- [ ] paid path requires review or explicit threshold policy
- [ ] ambiguity fails closed
- [ ] missing quote fails closed
- [ ] missing receipt triggers review

### Hosted Execution

- [ ] quote flow is documented
- [ ] procurement flow is documented
- [ ] approval flow is documented
- [ ] execution flow is documented
- [ ] receipt fetch flow is documented
- [ ] reconciliation review flow is documented

### Auditability

- [ ] request id is preserved end to end
- [ ] quote id is preserved
- [ ] invocation id is preserved
- [ ] receipt id is preserved
- [ ] policy version is preserved
- [ ] input and output hashes are preserved
- [ ] reviewer or actor identity is preserved where applicable

## Common Launch Failures

### 1. Free Listing With Hidden Paid Behavior

Symptom:
A listing is described as free but triggers external paid execution later in the flow.

Fix:
Split the free listing from the paid listing. Give them separate policy revisions and separate review status.

### 2. Receipt Without Policy Context

Symptom:
The run has a receipt id, but reviewers cannot tell why the run was allowed.

Fix:
Persist policy name, version, and decision summary in the audit trail.

### 3. Approval Path Added Too Late

Symptom:
The first paid request arrives before there is a supervisor review packet format.

Fix:
Write the approval packet format during the free launch stage, even if no approvals are expected yet.

### 4. Output Is Reviewable But Input Is Not Stable

Symptom:
The result looks good, but the input contract is too broad to govern.

Fix:
Narrow the schema until procurement and approval decisions can be made from it reliably.

### 5. Reconciliation Is Treated As Optional

Symptom:
Execution succeeds, but budget drift is discovered days later.

Fix:
Require reconciliation review after every launch-stage run.

## Suggested Repository Placement

This document fits naturally under one of these paths:

- `agent-os/MARKETPLACE_AGENT_OS_LAUNCH_PLAN.md`
- `harness-core/MARKETPLACE_AGENT_OS_LAUNCH_PLAN.md`
- `docs/MARKETPLACE_AGENT_OS_LAUNCH_PLAN.md`

If the repository prefers product-boundary docs to live near the public control-plane examples, place it under `agent-os/`.

If the repository prefers launch readiness to begin from local proof and listing-readiness artifacts, place it under `harness-core/`.

## Minimal Maintainer Review Standard

A maintainer should be able to approve or request changes based on these questions alone:

1. Is the first listing narrow enough to govern?
2. Does the policy fail closed?
3. Can the builder prove what happened locally?
4. Can the hosted path produce a quote, policy decision, receipt, and reconciliation record?
5. Is there any unsupported claim about private infrastructure or automatic publication?

If any answer is no, the launch plan is incomplete.

## Final Rule

Treat the first Marketplace Agent OS launch as a governance exercise, not a growth exercise.

A launch is ready when the agent is:

- productized as one bounded capability
- policy-constrained before monetization
- approval-aware before scale
- receipt-backed on every execution path
- reviewable after the fact by someone who was not present during the run