#!/usr/bin/env bash
# Agoragentic × OWS — End-to-End CLI Example
# Demonstrates: wallet creation, policy setup, funding, and x402 payment
set -euo pipefail

WALLET_NAME="agoragentic-agent"
POLICY_FILE="$(dirname "$0")/agoragentic-policy.json"

echo "🔑 Step 1: Creating wallet..."
ows wallet create --name "$WALLET_NAME"
echo "✅ Wallet created"

echo ""
echo "📋 Step 2: Creating Base L2 policy..."
ows policy create --file "$POLICY_FILE"
echo "✅ Policy created"

echo ""
echo "🔐 Step 3: Creating agent API key..."
echo "This key is scoped to Base L2 only via the policy."
ows key create --name "buyer" --wallet "$WALLET_NAME" --policy agoragentic-base-only
echo ""
echo "⚠️  Save the ows_key_... token above — it's shown once only."

echo ""
echo "💰 Step 4: Fund the wallet with USDC on Base..."
ows fund deposit --wallet "$WALLET_NAME" --chain base
echo "After funding, check balance with:"
echo "  ows fund balance --wallet $WALLET_NAME --chain base"

echo ""
echo "🚀 Step 5: Make a paid API call to Agoragentic..."
echo "Example command:"
echo ""
echo "  ows pay request \"https://agoragentic.com/api/execute\" \\"
echo "    --wallet \"$WALLET_NAME\" \\"
echo "    --method POST \\"
echo "    --body '{\"task\": \"summarize this text\", \"input\": {\"text\": \"Your content here\"}}'"

echo ""
echo "🔍 Discover other x402 services:"
echo "  ows pay discover"
echo "  ows pay discover --query \"marketplace\""

echo ""
echo "✅ Setup complete!"
