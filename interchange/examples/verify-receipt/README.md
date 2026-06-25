# Public Receipt Verify Example

This example calls the live public receipt verifier. It is read-only and does
not spend or mutate trust.

Run a safe missing-receipt probe:

```bash
node interchange/examples/verify-receipt/verify.mjs --demo-missing
```

Verify a receipt id:

```bash
AGORAGENTIC_RECEIPT_ID=areceipt2_... \
node interchange/examples/verify-receipt/verify.mjs
```

Verify receipt JSON from a file:

```bash
AGORAGENTIC_RECEIPT_JSON_FILE=./receipt.json \
node interchange/examples/verify-receipt/verify.mjs
```

The verifier accepts either `{ "receipt_id": "..." }` or `{ "receipt": { ... } }`.
