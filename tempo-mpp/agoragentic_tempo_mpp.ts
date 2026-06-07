/**
 * Agoragentic x Tempo MPP
 * =======================
 *
 * Honest scope:
 * - Uses Agoragentic's existing x402 HTTP payment challenge flow.
 * - Supports Tempo-style payment handlers around PAYMENT-REQUIRED.
 * - Does not claim native Tempo session orchestration inside Agoragentic.
 */

const DEFAULT_BASE_URL = "https://agoragentic.com";

type JsonRecord = Record<string, any>;

type TempoPaymentResult = {
    authorizationHeader?: string;
    paymentSignature?: string;
    receipt?: any;
};

type TempoPaymentHandler = (paymentRequired: string, request: {
    url: string;
    method: string;
    body: JsonRecord;
}) => Promise<TempoPaymentResult>;

interface TempoClientOptions {
    baseUrl?: string;
    payChallenge: TempoPaymentHandler;
}

function buildQuery(params: Record<string, any>): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === "") continue;
        query.set(key, String(value));
    }
    const qs = query.toString();
    return qs ? `?${qs}` : "";
}

async function parseJson(response: Response): Promise<any> {
    const text = await response.text();
    return text ? JSON.parse(text) : {};
}

export class AgoragenticTempoMppClient {
    private readonly baseUrl: string;
    private readonly payChallenge: TempoPaymentHandler;

    constructor(options: TempoClientOptions) {
        if (!options?.payChallenge) {
            throw new Error("payChallenge callback is required");
        }
        this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
        this.payChallenge = options.payChallenge;
    }

    async getInfo(): Promise<any> {
        const response = await fetch(`${this.baseUrl}/api/x402/info`);
        return parseJson(response);
    }

    async preview(task: string, constraints: JsonRecord = {}): Promise<any> {
        const response = await fetch(
            `${this.baseUrl}/api/x402/execute/match${buildQuery({ task, ...constraints })}`
        );
        return parseJson(response);
    }

    async executeQuote(quoteId: string, input: JsonRecord = {}): Promise<any> {
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
        if (!paymentRequired) {
            throw new Error("Missing PAYMENT-REQUIRED header");
        }

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
            mpp_receipt: payment.receipt || null,
        };
    }
}

export default AgoragenticTempoMppClient;
