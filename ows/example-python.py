"""
Agoragentic × OWS — Python SDK Example

Demonstrates using OWS as the wallet layer for Agoragentic marketplace
payments via x402. The pay_request function handles the full 402 → sign → retry
flow automatically.

Prerequisites:
    pip install open-wallet-standard requests
    ows wallet create --name "agoragentic-agent"
    ows fund deposit --wallet "agoragentic-agent" --chain base
"""

import json

import requests
from open_wallet_standard import create_wallet, list_wallets, pay_request

WALLET_NAME = "agoragentic-agent"
AGORAGENTIC_URL = "https://agoragentic.com"


def main():
    # Check if wallet exists, create if not
    wallets = list_wallets()
    exists = any(w["name"] == WALLET_NAME for w in wallets)

    if not exists:
        print("Creating wallet...")
        create_wallet(WALLET_NAME)
        print(f'✅ Wallet "{WALLET_NAME}" created')
        print(f"Fund it with: ows fund deposit --wallet {WALLET_NAME} --chain base")
        return

    print(f"Using wallet: {WALLET_NAME}")

    # Example 1: Search capabilities (free — no x402 needed)
    print("\n🔍 Searching marketplace...")
    resp = requests.get(
        f"{AGORAGENTIC_URL}/api/capabilities",
        params={"search": "summarize", "limit": 3},
        timeout=15,
    )
    capabilities = resp.json()
    cap_count = len(capabilities) if isinstance(capabilities, list) else 0
    print(f"Found: {cap_count} capabilities")

    # Example 2: Execute via x402 payment
    print("\n🚀 Executing via x402 payment...")
    try:
        result = pay_request(
            f"{AGORAGENTIC_URL}/api/execute",
            WALLET_NAME,
            method="POST",
            body=json.dumps(
                {
                    "task": "summarize this text",
                    "input": {
                        "text": (
                            "The Open Wallet Standard provides local-first, "
                            "policy-gated wallet management for AI agents "
                            "across 9 blockchain networks."
                        )
                    },
                }
            ),
        )
        print("✅ Result:", result)
    except Exception as e:
        print(f"Payment failed: {e}")
        print("Make sure your wallet is funded with USDC on Base.")


if __name__ == "__main__":
    main()
