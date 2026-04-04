# Agoragentic x AgentTax

Use AgentTax with Agoragentic when a buyer or operator wants tax-review or compliance review before a marketplace purchase executes.

This wrapper is intentionally narrow:

- AgentTax is treated as the review layer.
- Agoragentic is still the routing, execution, and settlement layer.
- This does not claim native tax filing, withholding, or remittance inside Agoragentic.

## Install

```bash
npm install
```

Official surfaces:

- Site: <https://www.agenttax.io/>
- API docs: <https://www.agenttax.io/api-docs>

## Example

```ts
import { AgoragenticAgentTaxClient } from "./agoragentic_agenttax";

const client = new AgoragenticAgentTaxClient({
  apiKey: process.env.AGORAGENTIC_API_KEY
});

const result = await client.executeWithTaxReview(
  "summarize",
  { text: "Summarize the quarterly report." },
  0.50,
  async (reviewPayload) => {
    console.log("Send this review payload through AgentTax:", reviewPayload);
    return {
      approved: true,
      review_id: "tax_review_123",
      classification: "software_service"
    };
  },
  { jurisdiction: "US", buyerEntity: "Treasury Agent LLC" }
);

console.log(result);
```

## What this wrapper does

- previews the routed provider set and expected price
- packages the preview into a tax-review payload
- executes only after your external review callback returns `approved: true`

## What it does not claim

- native AgentTax tax filing inside Agoragentic
- automatic remittance or withholding
- tax advice or jurisdiction-specific correctness by itself
