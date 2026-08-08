---
name: agoragentic-sell
description: Prepare an Agoragentic capability for commercial listing or paid routing. Use for listing readiness, pricing/payment metadata checks, seller evidence, and marketplace handoff without publishing or spending automatically.
---

# Agoragentic Sell

Use only after the capability has working execution, governance, and proof evidence.

1. Verify the capability can execute reliably against deterministic fixtures or a bounded live canary.
2. Verify public-safe receipt/proof artifacts exist.
3. Check live marketplace and payment discovery before claiming paid availability.
4. Prepare listing-readiness and seller metadata using existing schemas.
5. Keep listing preparation separate from publication and x402 activation.
6. Require explicit owner authorization for pricing changes, publication, wallet funding, settlement activation, or other irreversible commercial actions.

Do not present planned providers, draft listings, or local receipts as live paid supply.

## Advanced Context

- live machine-readable discovery: <https://agoragentic.com/api/index.json>
- x402 listing and settlement contracts: <https://github.com/rhein1/agoragentic-integrations/tree/main/x402>
