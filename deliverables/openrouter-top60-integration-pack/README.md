# OpenRouter Top-60 Integration Review Pack

Reconciled against `rhein1/agoragentic-integrations@27aa21c613ee6ad5ae69e49659e3fd75ba2eccad`. The ranking transcription came from user-supplied screenshots. Those screenshots are not preserved in this PR, so the rank and token transcription is not independently reproducible from repository contents.

This compact review pack accounts for all 60 targets without inflating the active integration catalog. It contains 12 host assessments blocked pending qualified host enforcement, an OpenRouter Agent SDK candidate, bounded Codebuff and Oration adapters, and consolidated decision packets for existing coverage, composition, providers, plugins, vendor intake, blocked targets, uncertain identities, and deprecations.

## Validate

```bash
npm ci --ignore-scripts --prefix deliverables/openrouter-top60-integration-pack
npm --prefix deliverables/openrouter-top60-integration-pack run check
npm --prefix deliverables/openrouter-top60-integration-pack test
npm --prefix deliverables/openrouter-top60-integration-pack run typecheck
node --test test/mcp-direct-bypass.test.mjs
```

`npm ci` installs the pinned development dependencies; the check, test, and typecheck scripts themselves use local fixtures and do not make provider or Agoragentic network calls. `npm run check` runs the pack validator, JavaScript syntax checks, and the Codebuff TypeScript check. `npm test` discovers the semantic and adversarial contract suite without a hard-coded pass count. The final command runs from the repository root and rejects direct Agoragentic MCP bypass artifacts. These checks cover internal pack boundaries and cross-record consistency; they do not reproduce the missing ranking screenshots, qualify external hosts, or provide runtime evidence. Nothing here registers an agent, executes provider work, spends funds, starts a call, sends a message, publishes a listing, deploys a runtime, or changes trust/ranking state.

As of 2026-08-25, `npm audit` reports six vulnerable dependency packages (4 low, 1 moderate, 1 high) beneath the pinned, development-only `@codebuff/sdk@0.10.7` validation dependency. The registry offers a Codebuff SDK downgrade as its automatic remediation; this pack does not substitute an unverified SDK version merely to suppress the audit. Treat an upstream-clean dependency set or an explicit owner risk decision as another prerequisite for promotion.

## Candidate contract boundaries

- `match({ task, constraints })` and task-only `quote({ task, constraints })` use authenticated `GET /api/execute/match`; task quote does not call the nonexistent `/api/execute/quote` route.
- `receipt({ invocationId })` uses `GET /api/commerce/receipts/{encoded invocationId}`. The canonical endpoint accepts the raw invocation ID returned by execution.
- `match({ task, constraints })`, task-only `quote({ task, constraints })`, and `execute({ task, input, constraints })` reject a supplied `constraints.max_cost` unless it is finite and strictly positive, because the deployed router treats zero as an absent ceiling. Execute also refuses before network access unless the caller supplies that positive ceiling or a non-empty `constraints.quote_id`. A `quote_id` is promoted to the top-level execute body expected by the API. Tool approval is an additional gate, not a substitute for a caller-bound spend ceiling.
- The Oration adapter normalizes configured API base paths so both `/api/v2` and `/api/v2/` resolve conversation routes beneath `/v2/`. Creation accepts only `conversationType` values `chat`, `web`, or `telephony`; the existing creation, telephony, and do-not-disturb override gates remain fail-closed.

The candidate SDK treats an interrupted or server-failed `POST /api/execute` as outcome-unknown and non-retryable because the public contract does not provide a client-bound idempotency key. The Oration adapter applies the same rule to conversation creation. Reconcile platform activity or provider state with an operator before starting another execution or conversation. The match-only example validates both OpenRouter and Agoragentic credentials before making a model call.

There is no current Agoragentic MCP relay configuration. The registry relay is legacy and must not be used; repository source is an unpublished, non-installable protocol/reference surface; and remote MCP work remains blocked pending a qualified host-enforcement boundary. Hosts that can embed code may use the supported SDK or REST match path without treating that path as MCP qualification.

Promote a candidate into `integrations.json` only after a pinned primary contract, exact host/package version, focused tests, owner-approved external no-spend evidence, secret handling review, and truthful maturity labels exist.
