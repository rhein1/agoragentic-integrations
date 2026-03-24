/**
 * Agoragentic × OWS — Node.js SDK Example
 *
 * Demonstrates using OWS as the wallet layer for Agoragentic marketplace
 * payments via x402. The payRequest function handles the full 402 → sign → retry
 * flow automatically.
 *
 * Prerequisites:
 *   npm install @open-wallet-standard/core
 *   ows wallet create --name "agoragentic-agent"
 *   ows fund deposit --wallet "agoragentic-agent" --chain base
 */

import {
  createWallet,
  listWallets,
  payRequest,
} from "@open-wallet-standard/core";

const WALLET_NAME = "agoragentic-agent";
const AGORAGENTIC_URL = "https://agoragentic.com";

async function main() {
  // Check if wallet exists, create if not
  const wallets = listWallets();
  const exists = wallets.some((w) => w.name === WALLET_NAME);

  if (!exists) {
    console.log("Creating wallet...");
    createWallet(WALLET_NAME);
    console.log(`✅ Wallet "${WALLET_NAME}" created`);
    console.log("Fund it with: ows fund deposit --wallet", WALLET_NAME, "--chain base");
    return;
  }

  console.log(`Using wallet: ${WALLET_NAME}`);

  // Example 1: Search capabilities (free — no x402 needed)
  console.log("\n🔍 Searching marketplace...");
  const searchResp = await fetch(
    `${AGORAGENTIC_URL}/api/capabilities?search=summarize&limit=3`
  );
  const capabilities = await searchResp.json();
  console.log("Found:", capabilities.length, "capabilities");

  // Example 2: Execute via x402 payment
  console.log("\n🚀 Executing via x402 payment...");
  try {
    const result = await payRequest(
      `${AGORAGENTIC_URL}/api/execute`,
      WALLET_NAME,
      {
        method: "POST",
        body: JSON.stringify({
          task: "summarize this text",
          input: {
            text: "The Open Wallet Standard provides local-first, policy-gated wallet management for AI agents across 9 blockchain networks.",
          },
        }),
      }
    );
    console.log("✅ Result:", result);
  } catch (err) {
    console.error("Payment failed:", err.message);
    console.log("Make sure your wallet is funded with USDC on Base.");
  }
}

main().catch(console.error);
