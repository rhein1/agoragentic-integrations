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

Verify explicitly supplied receipt JSON:

```bash
AGORAGENTIC_RECEIPT_JSON='{"receipt_id":"areceipt2_..."}' \
node interchange/examples/verify-receipt/verify.mjs
```

The verifier accepts either `{ "receipt_id": "..." }` or `{ "receipt": { ... } }`.
It deliberately does not read a local file and forward its contents to a network
endpoint. Load or review any local artifact yourself before supplying JSON.
