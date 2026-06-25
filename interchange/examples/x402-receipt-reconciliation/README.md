# x402 Receipt Reconciliation Preflight

This example performs the safe first step of an x402 buyer flow: it sends an
unpaid request to the live `receipt-reconciliation` resource and prints the 402
payment challenge.

It does not sign a payment, does not read a private key, and does not spend.

```bash
node interchange/examples/x402-receipt-reconciliation/preflight.mjs
```

Expected result: HTTP `402`, `network: eip155:8453`, and a `10000` atomic USDC
requirement for `https://x402.agoragentic.com/v1/receipt-reconciliation`.

To make a real paid call, replace this preflight with your own wallet-aware x402
client and keep the signer in your wallet, HSM, or managed-wallet runtime. Do
not send private keys to Agoragentic.
