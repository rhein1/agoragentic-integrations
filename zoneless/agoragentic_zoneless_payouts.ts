/**
 * Experimental Agoragentic + Zoneless payout bridge.
 *
 * Terminology:
 * - `gpt-5.6-sol` is a model identifier and is unrelated to crypto.
 * - Solana is the network; SOL is its native token; lamports are SOL's smallest unit.
 * - This helper models optional Solana USDC seller payouts only.
 *
 * Boundary:
 * - Agoragentic remains the Agent OS / Router / Marketplace / receipt system.
 * - Base remains canonical internal accounting and seller settlement in V1.
 * - Solana USDC payout is only an optional future seller payout rail.
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

export type AgoragenticPayoutStatus =
  | "draft"
  | "pending_signature"
  | "submitted"
  | "confirmed"
  | "failed";

export type AgoragenticPayoutReceiptDraft = {
  receipt_type: "seller_payout";
  seller_id: string;
  canonical_earnings_network: "base";
  canonical_earnings_asset: "USDC";
  payout_network: "solana";
  payout_asset: "USDC";
  amount_usdc: string;
  amount_minor_units: string;
  source_receipts: string[];
  payout_tx?: string;
  status: AgoragenticPayoutStatus;
  settlement_confirmed: boolean;
};

export type ZonelessPayoutRequest = {
  amount: string;
  currency: "usdc";
  destination: string;
  metadata: {
    agoragentic_seller_id: string;
    canonical_network: "base";
    source_receipts: string;
  };
};

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((char, index) => [char, index]));

export function parseUsdcMinorUnits(amountUsdc: string): bigint {
  if (typeof amountUsdc !== "string") throw new Error("USDC amount must be a string");
  const normalized = amountUsdc.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(normalized)) {
    throw new Error("USDC amount must be a positive decimal string with at most 6 fractional digits");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const minor = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (minor <= 0n) throw new Error("USDC amount must be greater than zero");
  return minor;
}

export function decodeBase58(value: string): Uint8Array {
  if (!value || typeof value !== "string") throw new Error("Solana address must be a non-empty string");
  let number = 0n;
  for (const char of value) {
    const digit = BASE58_INDEX.get(char);
    if (digit === undefined) throw new Error("Solana address contains non-base58 characters");
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.push(Number(number & 255n));
    number >>= 8n;
  }
  bytes.reverse();
  const leadingZeroes = [...value].findIndex((char) => char !== "1");
  const prefixLength = leadingZeroes === -1 ? value.length : leadingZeroes;
  return Uint8Array.from([...new Array(prefixLength).fill(0), ...bytes]);
}

export function assertSolanaAddress(address: string): void {
  const decoded = decodeBase58(address);
  if (decoded.length !== 32) {
    throw new Error(`Solana address must decode to 32 bytes; received ${decoded.length}`);
  }
}

export function assertZonelessPayoutBoundary(preference: AgoragenticSellerPayoutPreference) {
  if (preference.canonical_balance_network !== "base") {
    throw new Error("Agoragentic seller balances must remain Base-canonical");
  }
  if (preference.canonical_balance_asset !== "USDC" || preference.preferred_payout_asset !== "USDC") {
    throw new Error("Only USDC payout assets are in scope");
  }
  if (preference.preferred_payout_network === "solana") {
    if (!preference.solana_wallet) throw new Error("Solana payout preference requires a seller Solana wallet");
    assertSolanaAddress(preference.solana_wallet);
  }
  if (preference.payout_mode !== "manual_batch" || preference.requires_owner_approval !== true) {
    throw new Error("Experimental Solana payout bridge requires manual batch approval");
  }
}

export function toZonelessPayoutRequest(input: {
  sellerId: string;
  amountUsdc: string;
  solanaWallet: string;
  sourceReceipts: string[];
}): ZonelessPayoutRequest {
  if (!input.sellerId.trim()) throw new Error("Seller id is required");
  if (!input.sourceReceipts.length || input.sourceReceipts.some((receipt) => !receipt.trim())) {
    throw new Error("Seller payout must link to non-empty source Agoragentic receipts");
  }
  assertSolanaAddress(input.solanaWallet);
  const minorUnits = parseUsdcMinorUnits(input.amountUsdc);
  return {
    amount: minorUnits.toString(),
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
  status?: AgoragenticPayoutStatus;
  settlementConfirmed?: boolean;
}): AgoragenticPayoutReceiptDraft {
  if (!input.sellerId.trim()) throw new Error("Seller id is required");
  if (!input.sourceReceipts.length || input.sourceReceipts.some((receipt) => !receipt.trim())) {
    throw new Error("Payout receipt requires non-empty source receipts");
  }
  const minorUnits = parseUsdcMinorUnits(input.amountUsdc);
  const status = input.status ?? (input.payoutTx ? "submitted" : "draft");
  const settlementConfirmed = input.settlementConfirmed === true;
  if (status === "confirmed" && !input.payoutTx) {
    throw new Error("Confirmed payout requires a transaction signature");
  }
  if (status === "confirmed" && !settlementConfirmed) {
    throw new Error("Confirmed payout requires explicit settlement confirmation");
  }
  if (settlementConfirmed && status !== "confirmed") {
    throw new Error("Settlement confirmation is only valid for confirmed payouts");
  }
  if (input.payoutTx && status === "draft") {
    throw new Error("A payout with a transaction signature cannot remain draft");
  }
  return {
    receipt_type: "seller_payout",
    seller_id: input.sellerId,
    canonical_earnings_network: "base",
    canonical_earnings_asset: "USDC",
    payout_network: "solana",
    payout_asset: "USDC",
    amount_usdc: input.amountUsdc,
    amount_minor_units: minorUnits.toString(),
    source_receipts: [...input.sourceReceipts],
    payout_tx: input.payoutTx,
    status,
    settlement_confirmed: settlementConfirmed,
  };
}
