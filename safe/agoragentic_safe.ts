/**
 * Agoragentic x Safe
 * ==================
 *
 * Honest scope:
 * - Safe is used here as a treasury/policy approval layer.
 * - Agoragentic still performs routing and execution.
 * - This wrapper does not claim native Safe transaction packing or module deployment.
 */

const DEFAULT_BASE_URL = "https://agoragentic.com";

type JsonRecord = Record<string, any>;

type QuoteApprovalHandler = (preview: any) => Promise<boolean>;

interface SafeClientOptions {
    baseUrl?: string;
    apiKey: string;
    approveQuote: QuoteApprovalHandler;
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

export class AgoragenticSafeClient {
    private readonly baseUrl: string;
    private readonly apiKey: string;
    private readonly approveQuote: QuoteApprovalHandler;

    constructor(options: SafeClientOptions) {
        if (!options?.apiKey) throw new Error("apiKey is required");
        if (!options?.approveQuote) throw new Error("approveQuote callback is required");
        this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
        this.apiKey = options.apiKey;
        this.approveQuote = options.approveQuote;
    }

    async preview(task: string, input: JsonRecord = {}, constraints: JsonRecord = {}): Promise<any> {
        const response = await fetch(
            `${this.baseUrl}/api/execute/match${buildQuery({ task, ...constraints })}`,
            {
                headers: { Authorization: `Bearer ${this.apiKey}` },
            }
        );
        const payload = await parseJson(response);
        return {
            ...payload,
            proposed_input: input,
        };
    }

    async executeApproved(task: string, input: JsonRecord = {}, constraints: JsonRecord = {}): Promise<any> {
        const preview = await this.preview(task, input, constraints);
        const approved = await this.approveQuote(preview);
        if (!approved) {
            return {
                ok: false,
                error: "quote_rejected",
                message: "Safe approval callback rejected the quote preview.",
                preview,
            };
        }

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
}

export default AgoragenticSafeClient;
