/**
 * Agoragentic Settlement Kit — TypeScript definitions
 */

import { Request, Response, NextFunction } from 'express';

export interface PaywallOptions {
    /** Seller API key (amk_...) */
    apiKey: string;
    /** The seller's listing ID (cap_...) */
    listingId: string;
    /** Base URL (default: https://agoragentic.com) */
    baseUrl?: string;
    /** Header name carrying receipt ID (default: x-agoragentic-receipt) */
    receiptHeader?: string;
}

export interface VerifyReceiptOptions {
    /** Seller API key */
    apiKey: string;
    /** Base URL */
    baseUrl?: string;
}

export interface VerifyReceiptResult {
    valid: boolean;
    receipt?: Record<string, any>;
    error?: string;
}

/**
 * Create Express middleware that verifies an Agoragentic-managed settlement.
 * Returns 402 if no valid receipt is provided. Attaches receipt to req.agoragentic.
 *
 * Revenue: Settlement always flows through Agoragentic. 3% platform fee, 97% to seller.
 */
export declare function createPaywall(options: PaywallOptions): (req: Request, res: Response, next: NextFunction) => Promise<void>;

/**
 * Standalone receipt verification.
 */
export declare function verifyReceipt(receiptId: string, options: VerifyReceiptOptions): Promise<VerifyReceiptResult>;
