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

type ChallengePaymentHandler = (paymentRequired: string, request: {
    url: string;
    method: string;
    body: JsonRecord;
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

export class AgoragenticAgenticWalletClient {
    private baseUrl: string;
    private apiKey: string | null;
    private payChallenge?: ChallengePaymentHandler;

    constructor(options: ClientOptions = {}) {
        this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
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
        const response = await fetch(`${this.baseUrl}/api/execute/match${queryString({ task, ...constraints })}`, {
            headers: { Authorization: `Bearer ${this.apiKey}` },
        });
        return parseJson(response);
    }

    async execute(task: string, input: JsonRecord = {}, constraints: JsonRecord = {}): Promise<any> {
        if (!this.apiKey) throw new Error("API key required for execute");
        const response = await fetch(`${this.baseUrl}/api/execute`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ task, input, ...constraints }),
        });
        return parseJson(response);
    }

    async x402ExecuteMatch(task: string, constraints: JsonRecord = {}): Promise<any> {
        const response = await fetch(`${this.baseUrl}/api/x402/execute/match${queryString({ task, ...constraints })}`);
        return parseJson(response);
    }

    async x402Execute(quoteId: string, input: JsonRecord = {}): Promise<any> {
        const requestBody = { quote_id: quoteId, input };
        const initial = await fetch(`${this.baseUrl}/api/x402/execute`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
        });

        if (initial.status !== 402) {
            return parseJson(initial);
        }

        const paymentRequired = initial.headers.get("PAYMENT-REQUIRED");
        if (!paymentRequired) throw new Error("Missing PAYMENT-REQUIRED header");
        if (!this.payChallenge) throw new Error("No payChallenge handler configured for x402");

        const payment = await this.payChallenge(paymentRequired, {
            url: `${this.baseUrl}/api/x402/execute`,
            method: "POST",
            body: requestBody,
        });

        const retryHeaders: Record<string, string> = {
            "Content-Type": "application/json",
        };
        if (payment.authorizationHeader) retryHeaders.Authorization = payment.authorizationHeader;
        if (payment.paymentSignature) retryHeaders["PAYMENT-SIGNATURE"] = payment.paymentSignature;

        const settled = await fetch(`${this.baseUrl}/api/x402/execute`, {
            method: "POST",
            headers: retryHeaders,
            body: JSON.stringify(requestBody),
        });

        const payload = await parseJson(settled);
        return {
            ...payload,
            payment_receipt: settled.headers.get("Payment-Receipt"),
            payment_response_header: settled.headers.get("PAYMENT-RESPONSE"),
            wallet_receipt: payment.receipt || null,
        };
    }
}

export default AgoragenticAgenticWalletClient;
