# x402 Receipt Reconciliation Preflight

This example performs the safe first step of an x402 buyer flow: it sends an
unpaid request to the deployed `receipt-reconciliation` resource. It prints the
402 payment challenge when the paid route is available, or the public error
code when an operational gate such as the custody freeze has paused it.

It does not sign a payment, does not read a private key, and does not spend.

```bash
node interchange/examples/x402-receipt-reconciliation/preflight.mjs
```

Available-state result: HTTP `402`, `network: eip155:8453`, and a `10000`
atomic USDC requirement for
`https://x402.agoragentic.com/v1/receipt-reconciliation`.

Paused-state result as of 2026-08-09: HTTP `503` with
`platform_custody_frozen`. The script exits non-zero in that state because a
deployed surface is not currently a payable surface.

To make a real paid call, replace this preflight with your own wallet-aware x402
client and keep the signer in your wallet, HSM, or managed-wallet runtime. Do
not send private keys to Agoragentic.
