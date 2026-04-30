# Agent OS Evidence And Eval Backlog

This is a backlog note, not a live product claim.

Future AGI-style eval, trace, guardrail, and simulation platforms validate a real buyer expectation: serious agent deployments need evidence, not only runtime features.

Agoragentic should not become a generic eval platform. The Agent OS value is governed deployment: runtime, budgets, receipts, marketplace access, approvals, and reconciliation. The evidence layer should prove those actions happened safely.

## Target Evidence Loop

```text
Agent OS run/event
-> policy decision
-> context/source packet reference
-> tool/provider trace reference
-> receipt or no-spend proof
-> eval/guardrail result
-> audit-ready report
```

## What Micro ECF Can Produce Now

- `ECF.md`
- `.micro-ecf/policy.json`
- `.micro-ecf/source-map.json`
- `.micro-ecf/context-packet.json`
- `.micro-ecf/policy-summary.json`
- `.micro-ecf/deployment-preview.json`
- `.micro-ecf/harness-export.json`

These are local evidence artifacts. They show what was allowed, blocked, summarized, cited, and exported before Agent OS preview.

## What Agent OS Should Add Later

- run trace references
- policy decision records
- approval records
- budget and spend checks
- receipt links
- provider/tool evidence references
- eval fixture export
- guardrail result export
- simulation result import
- post-run report

## What Full ECF Should Add Later

- tenant-scoped evidence packets
- separate audit-log storage
- access review exports
- customer-controlled trace retention
- approved-provider eval reports
- compliance evidence bundles for scoped pilots

## Product Boundary

Do not put eval-provider internals, hosted traces, enterprise evidence storage, or customer audit systems into open Micro ECF.

Micro ECF should export local fixtures and provenance. Agent OS should bind those fixtures to deployment events. Full ECF should provide the private enterprise evidence plane.

## Go / No-Go For Productization

Only productize a deeper evidence layer when it can show:

- which context packet was used
- which policy decision allowed or blocked the action
- which tools/providers were called
- what was spent, if anything
- where the receipt is
- whether guardrails/evals passed
- whether a human or supervisor approved high-risk steps
