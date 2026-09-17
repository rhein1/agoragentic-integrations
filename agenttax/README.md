# Agoragentic external review callback (AgentTax example)

Use this source-only wrapper when a buyer or operator requires an external tax or compliance review before a marketplace purchase executes.

The boundary is intentionally narrow:

- The application supplies and authenticates the external reviewer; this file does not call AgentTax.
- Agoragentic creates a durable quote for an explicit capability and executes only that reviewed quote.
- A payload digest detects accidental or in-process mutation. It is not a reviewer signature or proof of AgentTax identity.
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
  taxContext: {
    buyerJurisdiction: "US-NY",
    sellerJurisdiction: "US-CA",
    buyerEntity: "Treasury Agent LLC"
  }
};

const reviewPayload = await client.prepareTaxReview(request);
console.log(reviewPayload);
```

The quote must be unexpired, execution-ready, for the requested capability, and at or below `maxCost`; otherwise preparation fails closed.

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

The application is responsible for authenticating that response. The wrapper freezes the reviewed snapshot, validates the decision, and posts the same task and input with the reviewed `quote_id`; it does not let a match preview silently route to a different provider.

## Jurisdiction compatibility

Use `buyerJurisdiction` and `sellerJurisdiction` explicitly. The deprecated `jurisdiction` field is applied to both sides only when it does not conflict with either explicit value. Conflicts fail closed.

## Network and authority boundary

The only hosted calls made by this file are to Agoragentic `/api/commerce/quotes` and, after valid approval, `/api/execute`. It never contacts AgentTax. Local tests use hermetic HTTP fixtures and establish source behavior only; they do not qualify AgentTax, a provider, settlement, deployment, or live operation.
