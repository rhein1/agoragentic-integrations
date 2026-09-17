# Agoragentic external review callback (AgentTax example)

Use this source-only wrapper when a buyer or operator requires an external tax or compliance review before a marketplace purchase executes.

The boundary is intentionally narrow:

- The application supplies and authenticates the external reviewer; this file does not call AgentTax.
- Agoragentic creates a durable quote for an explicit capability and executes only that reviewed quote.
- An RFC 8785/JCS SHA-256 payload digest detects accidental or in-process mutation. It is not a reviewer signature or proof of AgentTax identity.
- This wrapper does not claim tax filing, withholding, remittance, or jurisdiction-specific correctness.

## Installation

Copy `agoragentic_agenttax.ts` into an application with a TypeScript toolchain. This directory has no package manifest and no published AgentTax package dependency.

AgentTax reference links, not qualified dependencies:

- Site: <https://www.agenttax.io/>
- API docs: <https://www.agenttax.io/api-docs>

## No-spend review packet

`prepareTaxReview` calls the Agoragentic quote endpoint, which is a network operation but does not execute the purchase.

```ts
import { AgoragenticAgentTaxClient } from "./agoragentic_agenttax";

const client = new AgoragenticAgentTaxClient({
  apiKey: process.env.AGORAGENTIC_API_KEY
});

const request = {
  capabilityId: "cap_reviewed_listing",
  task: "summarize",
  input: { text: "Summarize the quarterly report." },
  maxCost: 0.50,
  units: 1,
  taxContext: {
    buyerJurisdiction: "US-NY",
    sellerJurisdiction: "US-CA",
    buyerEntity: "Treasury Agent LLC"
  }
};

const reviewPayload = await client.prepareTaxReview(request);
console.log(reviewPayload);
```

The quote must be unexpired, execution-ready, for the requested capability, single-unit, and at or below `maxCost`; otherwise preparation fails closed. Multi-unit execution is not qualified by this wrapper.

## Reviewed execution

`executeWithTaxReview` can spend. Call it only after replacing the fail-closed callback below with a separately authenticated reviewer integration.

```ts
const result = await client.executeWithTaxReview(
  request,
  async () => ({
    approved: false,
    status: "denied",
    reason: "No authenticated external reviewer is configured."
  })
);

console.log(result); // { status: "blocked", ... }
```

An approving reviewer must return all of these fields:

- `approved: true`
- `status: "approved"` (missing status never implies approval)
- a non-empty `review_id`
- the exact `review_payload_sha256` from the reviewed packet
- a valid future `expires_at`

The application is responsible for authenticating that response. The wrapper freezes the reviewed snapshot, validates the decision, and posts the same input with the reviewed `quote_id`; it does not let a match preview silently route to a different provider. The digest uses RFC 8785 JSON Canonicalization Scheme ordering and rejects non-JSON values, unpaired Unicode surrogates, accessors, sparse arrays, and non-finite numbers.

## Pending approval and same-quote retry

Agoragentic can return `pending_approval` when a platform supervisor must approve the purchase. Do not create a new quote. After the supervisor explicitly approves that request, retry the preserved packet and decision:

```ts
if (result.execution_state === "pending_approval") {
  // Resolve the named approval through the separately authorized supervisor flow first.
  const completed = await client.retryPendingTaxReview(result);
  console.log(completed);
}
```

`retryPendingTaxReview` accepts only the frozen, one-use, in-memory pending result issued by the same client instance. It rejects copied, reloaded, mutated, replayed, or non-pending results; verifies that the result and reviewed packet carry the same quote ID; and revalidates the payload, review, and expiries. It does not approve the supervisor request. If the process or pending handle is lost, use the canonical Agent OS supervisor/reconciliation flow rather than manufacturing a replacement result.

## Ambiguous execution outcome

A connection failure, 5xx response, non-JSON response, unknown 2xx status, empty HTTP 202 response, or malformed success envelope after `POST /api/execute` may mean the paid request reached the server. Successful execution requires an explicit `success` or `completed` status plus a non-empty invocation ID. Pending approval requires an explicit `pending_approval` indicator plus an approval ID. Otherwise the wrapper throws `TaxReviewedExecutionError` with:

- `code: "tax_reviewed_execution_outcome_unknown"`
- the exact `quote_id`
- `retryable: false`
- `reconciliation_path: "/api/commerce/reconciliation"`

Do not call `executeWithTaxReview` again after this error: that would create a new quote and could duplicate paid work. Reconcile platform activity or receipts with an operator first. Explicit 4xx or 2xx error envelopes use `code: "tax_reviewed_execution_rejected"` and also preserve the quote ID.

## Migration from the earlier source example

This hardening revision intentionally changes the experimental copy-file API:

- positional `prepareTaxReview(task, input, maxCost, context)` becomes `prepareTaxReview(request)`
- positional `executeWithTaxReview(task, input, maxCost, callback, context)` becomes `executeWithTaxReview(request, callback)`
- the unbound `match()` helper is removed; execution now requires an explicit capability and durable quote

Compatibility overloads are not provided because the earlier preview-then-route flow could review one provider and execute another. Existing source copies must migrate deliberately.

## Jurisdiction compatibility

Use `buyerJurisdiction` and `sellerJurisdiction` explicitly. The deprecated `jurisdiction` field is applied to both sides only when it does not conflict with either explicit value. Conflicts fail closed.

## Network and authority boundary

The only hosted calls made by this file are to Agoragentic `/api/commerce/quotes` and, after valid approval, `/api/execute`. It never contacts AgentTax. Local tests use hermetic HTTP fixtures and establish source behavior only; they do not qualify AgentTax, a provider, settlement, deployment, or live operation.
