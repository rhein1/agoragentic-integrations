/**
 * Experimental Agoragentic + Zoneless payout bridge.
 *
 * Boundary:
 * - Agoragentic remains the Agent OS / Router / Marketplace / receipt system.
 * - Base remains canonical internal accounting and seller settlement in V1.
 * - Zoneless-style Solana USDC payout is only an optional future seller payout rail.
 * - Do not use this helper for buyer execution, x402, runtime funding, or Solana intake normalization.
 */

export type AgoragenticSellerPayoutPreference = {
  seller_id: string;
  canonical_balance_network: "base";
  canonical_balance_asset: "USDC";
  preferred_payout_network: "base" | "solana";
  preferred_payout_asset: "USDC";
  solana_wallet?: string;
  payout_mode: "manual_batch";
  requires_owner_approval: true;
};

export type AgoragenticPayoutReceiptDraft = {
  receipt_type: "seller_payout";
  seller_id: string;
  canonical_earnings_network: "base";
  canonical_earnings_asset: "USDC";
  payout_network: "solana";
  payout_asset: "USDC";
  amount_usdc: string;
  source_receipts: string[];
  payout_tx?: string;
  status: "draft" | "pending_signature" | "paid" | "failed";
};

export type ZonelessPayoutRequest = {
  amount: number;
  currency: "usdc";
  destination: string;
  metadata: {
    agoragentic_seller_id: string;
    canonical_network: "base";
    source_receipts: string;
  };
};

export function assertZonelessPayoutBoundary(preference: AgoragenticSellerPayoutPreference) {
  if (preference.canonical_balance_network !== "base") {
    throw new Error("Agoragentic seller balances must remain Base-canonical");
  }
  if (preference.canonical_balance_asset !== "USDC" || preference.preferred_payout_asset !== "USDC") {
    throw new Error("Only USDC payout assets are in scope");
  }
  if (preference.preferred_payout_network === "solana" && !preference.solana_wallet) {
    throw new Error("Solana payout preference requires a seller Solana wallet");
  }
  if (preference.payout_mode !== "manual_batch" || preference.requires_owner_approval !== true) {
    throw new Error("Experimental Zoneless payout bridge requires manual batch approval");
  }
}

export function toZonelessPayoutRequest(input: {
  sellerId: string;
  amountUsdc: string;
  solanaWallet: string;
  sourceReceipts: string[];
}): ZonelessPayoutRequest {
  if (!input.sourceReceipts.length) {
    throw new Error("Seller payout must link to source Agoragentic receipts");
  }
  return {
    amount: Math.round(Number(input.amountUsdc) * 100),
    currency: "usdc",
    destination: input.solanaWallet,
    metadata: {
      agoragentic_seller_id: input.sellerId,
      canonical_network: "base",
      source_receipts: input.sourceReceipts.join(","),
    },
  };
}

export function buildPayoutReceiptDraft(input: {
  sellerId: string;
  amountUsdc: string;
  sourceReceipts: string[];
  payoutTx?: string;
  paid?: boolean;
}): AgoragenticPayoutReceiptDraft {
  if (!input.sourceReceipts.length) {
    throw new Error("Payout receipt requires source receipts");
  }
  return {
    receipt_type: "seller_payout",
    seller_id: input.sellerId,
    canonical_earnings_network: "base",
    canonical_earnings_asset: "USDC",
    payout_network: "solana",
    payout_asset: "USDC",
    amount_usdc: input.amountUsdc,
    source_receipts: input.sourceReceipts,
    payout_tx: input.payoutTx,
    status: input.paid ? "paid" : input.payoutTx ? "pending_signature" : "draft",
  };
}
