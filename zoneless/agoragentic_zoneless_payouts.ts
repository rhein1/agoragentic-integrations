/**
 * Experimental, offline Agoragentic + Zoneless seller-payout reference.
 *
 * Base remains canonical accounting and V1 seller settlement. This module has
 * no transport, credentials, signer, chain verifier, or execution authority.
 * Do not use it for buyer execution, x402, runtime funding, or Solana intake.
 * A locally consistent draft does not authenticate a seller or authorize spend.
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

export type SellerPayoutInput = {
  sellerId: string;
  amountUsdc: string;
  solanaWallet: string;
  sourceReceipts: string[];
};

/** Internal six-decimal accounting draft, NOT a Zoneless API request. */
export type AgoragenticSellerPayoutDraft = {
  schema: "agoragentic.seller-payout-draft.v1";
  execution_authority: "none";
  seller_id: string;
  canonical_balance_network: "base";
  canonical_balance_asset: "USDC";
  payout_network: "solana";
  payout_asset: "USDC";
  amount_usdc: string;
  amount_atomic_units: string;
  destination_wallet_address: string;
  source_receipts: string[];
};

/** Caller-supplied reference data; consistency checks are NOT authentication. */
export type ZonelessSellerWalletReference = {
  seller_id: string;
  id: string;
  account: string;
  wallet_address: string;
  object: "wallet";
  network: "solana";
  currency: "usdc";
  status: "new" | "validated" | "verified" | "verification_failed" | "errored" | "archived";
};

/** Offline request shape only. Nothing in this envelope grants spend authority. */
export type ZonelessPayoutRequestDraft = {
  schema: "agoragentic.zoneless-payout-request-draft.v1";
  execution_authority: "none";
  body: {
    /** Integer cents, NOT six-decimal USDC atomic units. */
    amount: number;
    currency: "usdc";
    /** Registered external-wallet object ID, NOT a raw Solana address. */
    destination: string;
    metadata: {
      agoragentic_seller_id: string;
      canonical_network: "base";
      source_receipts: string;
      source_receipts_encoding: "json";
    };
  };
  request_options: { zonelessAccount: string };
};

export type AgoragenticPayoutStatus =
  | "draft"
  | "pending_signature"
  | "simulated"
  | "submitted"
  | "failed";

export type AgoragenticPayoutReceiptDraft = {
  schema: "agoragentic.seller-payout-receipt-draft.v2";
  receipt_type: "seller_payout_draft";
  execution_authority: "none";
  evidence_mode: "simulated" | "onchain";
  evidence_source: "caller_supplied_unverified";
  chain_verification: "not_performed";
  seller_id: string;
  canonical_earnings_network: "base";
  canonical_earnings_asset: "USDC";
  payout_network: "solana";
  payout_asset: "USDC";
  amount_usdc: string;
  amount_atomic_units: string;
  source_receipts: string[];
  payout_tx?: string;
  status: AgoragenticPayoutStatus;
  settlement_confirmed: false;
};

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((char, index) => [char, index]));
const ATOMIC_UNITS_PER_CENT = 10_000n;

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

/** Exact conversion for the upstream JSON API; never rounds sub-cent amounts. */
export function toZonelessCents(amountUsdc: string): number {
  const atomic = parseUsdcMinorUnits(amountUsdc);
  if (atomic % ATOMIC_UNITS_PER_CENT !== 0n) {
    throw new Error("Zoneless requires whole cents; sub-cent USDC amounts cannot be rounded");
  }
  const cents = atomic / ATOMIC_UNITS_PER_CENT;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Zoneless cent amount exceeds the safe integer range");
  }
  return Number(cents);
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
  if (!["base", "solana"].includes(preference.preferred_payout_network)) {
    throw new Error("Unsupported seller payout network");
  }
  if (preference.preferred_payout_network === "solana") {
    if (!preference.solana_wallet) throw new Error("Solana payout preference requires a seller Solana wallet");
    assertSolanaAddress(preference.solana_wallet);
  }
  if (preference.payout_mode !== "manual_batch" || preference.requires_owner_approval !== true) {
    throw new Error("Experimental Solana payout bridge requires manual batch approval");
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace`);
  }
}

function assertPayoutIdentity(sellerId: string, sourceReceipts: string[]): void {
  assertIdentifier(sellerId, "Seller id");
  if (!Array.isArray(sourceReceipts) || !sourceReceipts.length) {
    throw new Error("Seller payout must link to non-empty source Agoragentic receipts");
  }
  for (const receipt of sourceReceipts) assertIdentifier(receipt, "Source receipt id");
}

export function buildSellerPayoutDraft(input: SellerPayoutInput): AgoragenticSellerPayoutDraft {
  assertPayoutIdentity(input.sellerId, input.sourceReceipts);
  assertSolanaAddress(input.solanaWallet);
  const atomic = parseUsdcMinorUnits(input.amountUsdc);
  return {
    schema: "agoragentic.seller-payout-draft.v1",
    execution_authority: "none",
    seller_id: input.sellerId,
    canonical_balance_network: "base",
    canonical_balance_asset: "USDC",
    payout_network: "solana",
    payout_asset: "USDC",
    amount_usdc: input.amountUsdc.trim(),
    amount_atomic_units: atomic.toString(),
    destination_wallet_address: input.solanaWallet,
    source_receipts: [...input.sourceReceipts],
  };
}

export function buildZonelessPayoutRequestDraft(input: SellerPayoutInput & {
  connectedAccountId: string;
  walletReference: ZonelessSellerWalletReference;
}): ZonelessPayoutRequestDraft {
  const draft = buildSellerPayoutDraft(input);
  assertIdentifier(input.connectedAccountId, "Connected account id");
  if (!/^acct_z_[A-Za-z0-9]+$/.test(input.connectedAccountId)) {
    throw new Error("Connected account id must be a Zoneless acct_z_ object id");
  }
  const wallet = input.walletReference;
  if (!wallet || typeof wallet !== "object") throw new Error("External wallet reference is required");
  assertIdentifier(wallet.id, "External wallet id");
  if (!/^wa_z_[A-Za-z0-9]+$/.test(wallet.id)) {
    throw new Error("Destination must be a registered wa_z_ external wallet id, not a raw address");
  }
  if (wallet.seller_id !== draft.seller_id || wallet.account !== input.connectedAccountId) {
    throw new Error("External wallet reference must match the seller and connected account");
  }
  if (wallet.wallet_address !== draft.destination_wallet_address) {
    throw new Error("External wallet address does not match the seller payout draft");
  }
  if (wallet.object !== "wallet" || wallet.network !== "solana" || wallet.currency !== "usdc") {
    throw new Error("External wallet reference must describe a Solana USDC wallet");
  }
  if (!["new", "validated", "verified"].includes(wallet.status)) {
    throw new Error("External wallet reference is archived, failed, or has an unsupported status");
  }
  return {
    schema: "agoragentic.zoneless-payout-request-draft.v1",
    execution_authority: "none",
    body: {
      amount: toZonelessCents(draft.amount_usdc),
      currency: "usdc",
      destination: wallet.id,
      metadata: {
        agoragentic_seller_id: draft.seller_id,
        canonical_network: "base",
        source_receipts: JSON.stringify(draft.source_receipts),
        source_receipts_encoding: "json",
      },
    },
    request_options: { zonelessAccount: input.connectedAccountId },
  };
}

/** This draft builder deliberately cannot produce a confirmed settlement. */
export function buildPayoutReceiptDraft(input: {
  sellerId: string;
  amountUsdc: string;
  sourceReceipts: string[];
  payoutTx?: string;
  status?: AgoragenticPayoutStatus;
  evidenceMode?: "simulated" | "onchain";
  /** Legacy input retained only to fail closed on caller-supplied confirmation. */
  settlementConfirmed?: boolean;
}): AgoragenticPayoutReceiptDraft {
  assertPayoutIdentity(input.sellerId, input.sourceReceipts);
  const atomic = parseUsdcMinorUnits(input.amountUsdc);
  if (String(input.status) === "confirmed"
    || (input.settlementConfirmed !== undefined && input.settlementConfirmed !== false)) {
    throw new Error("Independent settlement verification is not implemented; this helper cannot confirm payouts");
  }
  const mode = input.evidenceMode ?? "simulated";
  if (mode !== "simulated" && mode !== "onchain") throw new Error("Unknown payout evidence mode");
  const status = input.status ?? (input.payoutTx ? "submitted" : "draft");
  if (!["draft", "pending_signature", "simulated", "submitted", "failed"].includes(status)) {
    throw new Error("Unknown payout draft status");
  }
  if (mode === "simulated" && (status === "submitted" || input.payoutTx !== undefined)) {
    throw new Error("Simulated evidence cannot claim an onchain submission or transaction");
  }
  if (mode === "onchain" && status === "simulated") {
    throw new Error("Simulated status requires simulated evidence mode");
  }
  if (status === "submitted" && !input.payoutTx) {
    throw new Error("Submitted payout requires a transaction signature");
  }
  if (input.payoutTx !== undefined) {
    assertIdentifier(input.payoutTx, "Transaction signature");
    if (input.payoutTx.length > 88 || decodeBase58(input.payoutTx).length !== 64) {
      throw new Error("Transaction signature must decode to 64 bytes");
    }
    if (status !== "submitted" && status !== "failed") {
      throw new Error("A transaction signature requires submitted or failed status");
    }
  }
  return {
    schema: "agoragentic.seller-payout-receipt-draft.v2",
    receipt_type: "seller_payout_draft",
    execution_authority: "none",
    evidence_mode: mode,
    evidence_source: "caller_supplied_unverified",
    chain_verification: "not_performed",
    seller_id: input.sellerId,
    canonical_earnings_network: "base",
    canonical_earnings_asset: "USDC",
    payout_network: "solana",
    payout_asset: "USDC",
    amount_usdc: input.amountUsdc.trim(),
    amount_atomic_units: atomic.toString(),
    source_receipts: [...input.sourceReceipts],
    payout_tx: input.payoutTx,
    status,
    settlement_confirmed: false,
  };
}
