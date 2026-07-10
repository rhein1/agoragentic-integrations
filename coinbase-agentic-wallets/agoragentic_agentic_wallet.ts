/**
 * Coinbase Agentic Wallets x Agoragentic
 * ======================================
 *
 * Thin wrapper for two buyer modes:
 * 1. Registered API-key buyers calling execute()/match()
 * 2. Anonymous x402 buyers settling payment challenges through an external wallet callback
 *
 * Keep the wallet-specific signing and settlement logic outside this wrapper.
 */

const DEFAULT_BASE_URL = "https://agoragentic.com";

type JsonRecord = Record<string, any>;

type ChallengePaymentResult = {
    authorizationHeader?: string;
    paymentSignature?: string;
    receipt?: any;
};

export type X402Quote = {
    quote_id: string;
    quoted_price_usdc: number | string;
    payment_network?: string;
    payment_network_caip2?: string;
    settlement_network?: string;
    settlement_network_caip2?: string;
    settlement_asset_address?: string;
    execution_ready: boolean;
};

export type X402PaymentAuthorization = {
    payment_authorized: true;
    max_amount_usdc: number;
    expected_network: string;
    expected_asset: string;
    expected_pay_to: string;
    idempotency_key: string;
};

type ChallengePaymentHandler = (paymentRequired: string, request: {
    url: string;
    method: string;
    body: JsonRecord;
    quote: X402Quote;
    authorization: X402PaymentAuthorization;
}) => Promise<ChallengePaymentResult>;

interface ClientOptions {
    baseUrl?: string;
    apiKey?: string | null;
    payChallenge?: ChallengePaymentHandler;
}

function queryString(params: Record<string, any>): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === "") continue;
        query.set(key, String(value));
    }
    const out = query.toString();
    return out ? `?${out}` : "";
}

async function parseJson(response: Response): Promise<any> {
    const text = await response.text();
    return text ? JSON.parse(text) : {};
}

function requireFiniteNonNegative(value: unknown, name: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${name} must be a finite, non-negative number`);
    }
    return parsed;
}

function requireIdempotencyKey(value: unknown): string {
    const key = String(value || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(key)) {
        throw new Error("idempotency_key must be 1-200 letters, numbers, dots, underscores, colons, or hyphens");
    }
    return key;
}

function normalizeNetwork(value: unknown): string {
    const network = String(value || "").trim().toLowerCase();
    if (network === "base") return "eip155:8453";
    if (network === "base-sepolia") return "eip155:84532";
    return network;
}

function decodeBase64JsonHeader(value: string, label: string): any {
    const encoded = value.trim();
    if (!encoded || encoded.length > 131_072 || !/^[A-Za-z0-9+/_=-]+$/.test(encoded)) {
        throw new Error(`${label} header is missing or malformed`);
    }
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    try {
        const binary = globalThis.atob(padded);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new Error(`${label} header is not valid base64-encoded JSON`);
    }
}

function validatePaymentChallenge(
    headerValue: string,
    requestUrl: string,
    quote: X402Quote,
    authorization: X402PaymentAuthorization,
): void {
    const challenge = decodeBase64JsonHeader(headerValue, "PAYMENT-REQUIRED");
    if (challenge?.x402Version !== 2) {
        throw new Error("PAYMENT-REQUIRED challenge is not x402 version 2");
    }
    const expectedUrl = new URL(requestUrl).toString();
    let challengeUrl: string;
    try {
        challengeUrl = new URL(String(challenge?.resource?.url || "")).toString();
    } catch {
        throw new Error("PAYMENT-REQUIRED challenge has an invalid resource URL");
    }
    if (challengeUrl !== expectedUrl) {
        throw new Error("PAYMENT-REQUIRED resource does not match the requested execute URL");
    }

    const accepts = challenge?.accepts;
    if (!Array.isArray(accepts) || accepts.length === 0) {
        throw new Error("PAYMENT-REQUIRED challenge has no payment requirements");
    }
    const quotedPrice = requireFiniteNonNegative(quote.quoted_price_usdc, "quoted_price_usdc");
    const expectedAmount = Math.round(quotedPrice * 1_000_000);
    const maxAmount = Math.floor(requireFiniteNonNegative(authorization.max_amount_usdc, "max_amount_usdc") * 1_000_000);
    const expectedNetwork = normalizeNetwork(authorization.expected_network);
    const expectedAsset = String(authorization.expected_asset || "").trim().toLowerCase();
    const expectedPayTo = String(authorization.expected_pay_to || "").trim().toLowerCase();
    if (!expectedNetwork || !/^0x[a-f0-9]{40}$/.test(expectedAsset) || !/^0x[a-f0-9]{40}$/.test(expectedPayTo)) {
        throw new Error("expected network, asset, and payment recipient are required before payment");
    }

    for (const requirement of accepts) {
        if (String(requirement?.scheme || "").trim().toLowerCase() !== "exact") {
            throw new Error("PAYMENT-REQUIRED scheme is not the authorized exact-transfer scheme");
        }
        const amount = Number(requirement?.amount);
        if (!Number.isSafeInteger(amount) || amount < 0 || amount !== expectedAmount || amount > maxAmount) {
            throw new Error("PAYMENT-REQUIRED amount does not match the authorized quote and ceiling");
        }
        if (normalizeNetwork(requirement?.network) !== expectedNetwork) {
            throw new Error("PAYMENT-REQUIRED network does not match the authorized network");
        }
        if (String(requirement?.asset || "").trim().toLowerCase() !== expectedAsset) {
            throw new Error("PAYMENT-REQUIRED asset does not match the quoted settlement asset");
        }
        if (String(requirement?.payTo || "").trim().toLowerCase() !== expectedPayTo) {
            throw new Error("PAYMENT-REQUIRED recipient does not match the authorized recipient");
        }
    }
}

export class AgoragenticAgenticWalletClient {
    private baseUrl: string;
    private apiKey: string | null;
    private payChallenge?: ChallengePaymentHandler;
    private x402PaymentAttempted = false;
    private usedIdempotencyKeys = new Set<string>();

    constructor(options: ClientOptions = {}) {
        this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
        this.apiKey = options.apiKey || null;
        this.payChallenge = options.payChallenge;
    }

    setApiKey(apiKey: string): void {
        this.apiKey = apiKey;
    }

    async getX402Info(): Promise<any> {
        const response = await fetch(`${this.baseUrl}/api/x402/info`);
        return parseJson(response);
    }

    async match(task: string, constraints: JsonRecord = {}): Promise<any> {
        if (!this.apiKey) throw new Error("API key required for execute/match");
        const maxCost = requireFiniteNonNegative(constraints.max_cost, "max_cost");
        if (maxCost <= 0) {
            throw new Error("match max_cost must be positive; the deployed router treats zero as an absent ceiling");
        }
        const response = await fetch(`${this.baseUrl}/api/execute/match${queryString({ task, ...constraints, max_cost: maxCost })}`, {
            headers: { Authorization: `Bearer ${this.apiKey}` },
        });
        return parseJson(response);
    }

    async execute(task: string, input: JsonRecord = {}, constraints: JsonRecord = {}): Promise<any> {
        if (!this.apiKey) throw new Error("API key required for execute");
        const maxCost = requireFiniteNonNegative(constraints.max_cost, "max_cost");
        if (maxCost <= 0) {
            throw new Error("max_cost must be positive; the deployed router treats zero as an absent ceiling");
        }
        if (constraints.payment_authorized !== true) {
            throw new Error("paid execute requires payment_authorized: true after reviewing max_cost");
        }
        const idempotencyKey = requireIdempotencyKey(constraints.idempotency_key);
        if (this.usedIdempotencyKeys.has(idempotencyKey)) {
            throw new Error("idempotency_key was already attempted by this client");
        }
        const routerConstraints = { ...constraints, max_cost: maxCost };
        delete routerConstraints.payment_authorized;
        delete routerConstraints.idempotency_key;
        this.usedIdempotencyKeys.add(idempotencyKey);
        const response = await fetch(`${this.baseUrl}/api/execute`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                task,
                input,
                constraints: routerConstraints,
            }),
        });
        const data = await parseJson(response);
        if (!response.ok) throw new Error(`execute failed with HTTP ${response.status}`);
        return data;
    }

    async x402ExecuteMatch(task: string, constraints: JsonRecord = {}): Promise<any> {
        const response = await fetch(`${this.baseUrl}/api/x402/execute/match${queryString({ task, ...constraints })}`);
        return parseJson(response);
    }

    async x402Execute(
        quote: X402Quote,
        input: JsonRecord = {},
        authorization: X402PaymentAuthorization,
    ): Promise<any> {
        if (!quote || typeof quote !== "object" || !String(quote.quote_id || "").trim()) {
            throw new Error("x402Execute requires the complete quote returned by x402ExecuteMatch");
        }
        if (this.x402PaymentAttempted) {
            throw new Error("this client has already attempted an x402 payment; inspect receipt state before creating a newly authorized client");
        }
        if (!authorization || authorization.payment_authorized !== true) {
            throw new Error("x402 payment requires explicit payment_authorized: true");
        }
        const idempotencyKey = requireIdempotencyKey(authorization.idempotency_key);
        if (this.usedIdempotencyKeys.has(idempotencyKey)) {
            throw new Error("idempotency_key was already attempted by this client");
        }
        if (quote.execution_ready !== true) {
            throw new Error("x402 quote is not execution-ready on the requested payment rail");
        }
        const quotedPrice = requireFiniteNonNegative(quote.quoted_price_usdc, "quoted_price_usdc");
        const maxAmount = requireFiniteNonNegative(authorization.max_amount_usdc, "max_amount_usdc");
        if (quotedPrice > maxAmount) {
            throw new Error(`quoted price ${quotedPrice} USDC exceeds authorized maximum ${maxAmount} USDC`);
        }
        const quoteNetwork = String(
            quote.settlement_network_caip2
            || quote.settlement_network
            || quote.payment_network_caip2
            || quote.payment_network
            || "",
        ).trim();
        if (!authorization.expected_network || normalizeNetwork(quoteNetwork) !== normalizeNetwork(authorization.expected_network)) {
            throw new Error(`quote network ${quoteNetwork || "unknown"} does not match expected network ${authorization.expected_network}`);
        }
        if (String(quote.settlement_asset_address || "").trim().toLowerCase()
            !== String(authorization.expected_asset || "").trim().toLowerCase()) {
            throw new Error("quote settlement asset does not match the authorized asset");
        }
        this.usedIdempotencyKeys.add(idempotencyKey);
        const requestBody = {
            quote_id: String(quote.quote_id).trim(),
            input,
        };
        const requestUrl = `${this.baseUrl}/api/x402/execute`;
        const initial = await fetch(requestUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
        });

        if (initial.status !== 402) {
            const data = await parseJson(initial);
            if (!initial.ok) throw new Error(`x402 execute failed with HTTP ${initial.status}`);
            return data;
        }

        const paymentRequired = initial.headers.get("PAYMENT-REQUIRED")
            || initial.headers.get("X-PAYMENT-REQUIRED");
        if (!paymentRequired) throw new Error("Missing PAYMENT-REQUIRED header");
        if (!this.payChallenge) throw new Error("No payChallenge handler configured for x402");
        validatePaymentChallenge(paymentRequired, requestUrl, quote, authorization);
        this.x402PaymentAttempted = true;

        const payment = await this.payChallenge(paymentRequired, {
            url: requestUrl,
            method: "POST",
            body: requestBody,
            quote,
            authorization,
        });

        if (!payment.authorizationHeader && !payment.paymentSignature) {
            throw new Error("payChallenge returned no payment authorization or signature");
        }

        const retryHeaders: Record<string, string> = {
            "Content-Type": "application/json",
        };
        if (payment.authorizationHeader) retryHeaders.Authorization = payment.authorizationHeader;
        if (payment.paymentSignature) retryHeaders["PAYMENT-SIGNATURE"] = payment.paymentSignature;

        const settled = await fetch(requestUrl, {
            method: "POST",
            headers: retryHeaders,
            body: JSON.stringify(requestBody),
        });

        const payload = await parseJson(settled);
        if (settled.status === 402) {
            throw new Error("payment was not accepted; the server returned another payment challenge");
        }
        if (!settled.ok) throw new Error(`paid x402 execute failed with HTTP ${settled.status}`);
        const paymentResponse = settled.headers.get("PAYMENT-RESPONSE")
            || settled.headers.get("X-PAYMENT-RESPONSE");
        const paymentReceipt = settled.headers.get("Payment-Receipt");
        if (!paymentResponse || !paymentReceipt) {
            throw new Error("paid x402 execute returned no complete payment response and receipt proof");
        }
        const paymentResponsePayload = decodeBase64JsonHeader(paymentResponse, "PAYMENT-RESPONSE");
        const responseAmount = requireFiniteNonNegative(paymentResponsePayload?.amount_usdc, "payment response amount_usdc");
        if (String(paymentResponsePayload?.receipt_id || "") !== paymentReceipt) {
            throw new Error("PAYMENT-RESPONSE receipt does not match Payment-Receipt");
        }
        if (String(paymentResponsePayload?.quote_id || "") !== String(quote.quote_id)) {
            throw new Error("PAYMENT-RESPONSE quote does not match the authorized quote");
        }
        if (paymentResponsePayload?.settlement_status !== "settled") {
            throw new Error("PAYMENT-RESPONSE does not prove final settled status");
        }
        if (Math.round(responseAmount * 1_000_000) !== Math.round(quotedPrice * 1_000_000)) {
            throw new Error("PAYMENT-RESPONSE amount does not match the authorized quote");
        }
        return {
            ...payload,
            payment_receipt: paymentReceipt,
            payment_response_header: paymentResponse,
            payment_response: paymentResponsePayload,
            wallet_receipt: payment.receipt || null,
        };
    }
}

export default AgoragenticAgenticWalletClient;
