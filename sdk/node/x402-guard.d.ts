/**
 * Agoragentic x402 buyer guard — TypeScript definitions
 */

export interface X402BuyerPolicy {
    max_usdc_per_call?: number;
    daily_usdc_limit?: number | null;
    spent_usdc_today?: number;
    allowed_networks?: string[];
    allowed_assets?: string[];
    allowed_asset_addresses?: string[];
    allowed_schemes?: string[];
    allowed_domains?: string[];
    blocked_domains?: string[];
    require_receipt_header?: boolean;
    require_resource_match?: boolean;
    max_retries_per_request?: number;
    max_retries_per_minute?: number;
    retry_timestamps?: number[];
}

export interface X402RetryDecision {
    approved: true;
    audit_id: string;
    amount_usdc: number;
    resource_url: string;
    requirement: Record<string, any>;
    policy: {
        max_usdc_per_call?: number;
        daily_usdc_limit?: number | null;
        allowed_networks: string[];
        allowed_assets: string[];
        require_receipt_header?: boolean;
        require_resource_match?: boolean;
    };
}

export interface X402GuardOptions {
    policy?: X402BuyerPolicy;
    requestedUrl?: string;
    url?: string;
    retryCount?: number;
    auditId?: string;
    now?: number;
}

export interface X402SignPaymentInput {
    paymentRequired: Record<string, any>;
    requirement: Record<string, any>;
    audit_id: string;
    amount_usdc: number;
    resource_url: string;
}

export type X402SignPayment = (input: X402SignPaymentInput) => Promise<string | { signature?: string; payment?: string; headers?: Record<string, string> }> | string | { signature?: string; payment?: string; headers?: Record<string, string> };

export const BASE_MAINNET_USDC: string;
export const DEFAULT_X402_BUYER_POLICY: Required<Omit<X402BuyerPolicy, 'daily_usdc_limit'>> & { daily_usdc_limit: number | null };

export function decodePaymentRequired(headerValue: string): Record<string, any>;
export function parseUsdcAmount(requirement?: Record<string, any>): number;
export function normalizePolicy(policy?: X402BuyerPolicy): Required<Omit<X402BuyerPolicy, 'daily_usdc_limit'>> & { daily_usdc_limit: number | null };
export function selectRequirement(paymentRequired: Record<string, any>, policy: Required<X402BuyerPolicy>, requestedUrl: string): Record<string, any>;
export function authorizeX402Retry(paymentRequired: Record<string, any>, options?: X402GuardOptions): X402RetryDecision;
export function guardedX402Fetch(fetchImpl: typeof fetch, url: string, init: RequestInit | undefined, signPayment: X402SignPayment, policy?: X402BuyerPolicy, options?: Omit<X402GuardOptions, 'policy' | 'requestedUrl'>): Promise<Response & { x402?: X402RetryDecision }>;
export const guardedX402Retry: typeof guardedX402Fetch;
export function createX402AuditId(): string;
