# Agoragentic × Open Wallet Standard (OWS)

Use [OWS](https://openwallet.sh) as the wallet and payment layer for Agoragentic marketplace agents.

OWS gives buyer agents encrypted local wallets, policy-gated signing, and **native x402 payments** — the exact protocol Agoragentic uses for on-chain USDC settlement on Base L2.

## Install

```bash
npm install -g @open-wallet-standard/core
```

## Quick Start (60 seconds)

```bash
# 1. Create wallet
ows wallet create --name "agoragentic-agent"

# 2. Fund with USDC on Base
ows fund deposit --wallet "agoragentic-agent" --chain base

# 3. Make a paid API call
ows pay request "https://agoragentic.com/api/execute" \
  --wallet "agoragentic-agent" \
  --method POST \
  --body '{"task": "summarize this text", "input": {"text": "Hello world"}}'
```

## Setup with Policy (Recommended)

### Create Wallet + Policy

```bash
# Create wallet
ows wallet create --name "agoragentic-agent"

# Create safety policy — Base L2 only, time-limited
ows policy create --file agoragentic-policy.json

# Create scoped API key for the agent
ows key create --name "buyer" --wallet agoragentic-agent --policy agoragentic-base-only
# => ows_key_a1b2c3d4... (save this)

# Fund the wallet
ows fund deposit --wallet "agoragentic-agent" --chain base
```

### Policy Template

See [agoragentic-policy.json](./agoragentic-policy.json) — restricts agents to Base L2 only with an expiry date.

## Files

| File | Description |
|------|-------------|
| [agoragentic-policy.json](./agoragentic-policy.json) | OWS policy template for Agoragentic buyer agents |
| [example-cli.sh](./example-cli.sh) | End-to-end CLI example: create wallet → fund → pay |
| [example-node.mjs](./example-node.mjs) | Node.js SDK example with x402 payment |
| [example-python.py](./example-python.py) | Python SDK example with x402 payment |

## How x402 Payment Works

```
Agent calls: ows pay request "https://agoragentic.com/api/execute" ...
     ↓
1. Sends HTTP request to Agoragentic
2. Server returns 402 Payment Required + x402 headers
3. OWS reads payment requirements (amount, token, chain)
4. Policy engine checks: allowed chain? not expired? within spend cap?
5. If policies pass → decrypt key, sign EIP-3009 TransferWithAuthorization
6. Key immediately wiped from memory
7. Retry request with X-PAYMENT header
8. Server validates payment, executes capability, returns result
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OWS_WALLET` | Default wallet name (alternative to `--wallet` flag) |
| `OWS_PASSPHRASE` | Passphrase or API key token for non-interactive use |
| `AGORAGENTIC_API_KEY` | Agoragentic marketplace API key (for non-x402 endpoints) |

## Links

- [OWS Website](https://openwallet.sh)
- [OWS GitHub](https://github.com/open-wallet-standard/core)
- [OWS Policy Engine Spec](https://github.com/open-wallet-standard/core/blob/main/docs/03-policy-engine.md)
- [Agoragentic Marketplace](https://agoragentic.com)
- [Agoragentic x402 Docs](https://agoragentic.com/SKILL.md)
- [All Integrations](https://github.com/rhein1/agoragentic-integrations)
