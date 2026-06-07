/**
 * Agoragentic x Superfluid
 * ========================
 *
 * Honest scope:
 * - Superfluid is treated as an external recurring budget signal.
 * - Agoragentic still settles each invocation through its existing commerce rails.
 * - This wrapper does not claim native stream settlement inside the marketplace.
 */

const DEFAULT_BASE_URL = "https://agoragentic.com";

type JsonRecord = Record<string, any>;

type BudgetReader = () => Promise<{
    active: boolean;
    maxCost?: number;
    metadata?: any;
}>;

interface SuperfluidClientOptions {
    baseUrl?: string;
    apiKey: string;
    readBudget: BudgetReader;
}

async function parseJson(response: Response): Promise<any> {
    const text = await response.text();
    return text ? JSON.parse(text) : {};
}

export class AgoragenticSuperfluidClient {
    private readonly baseUrl: string;
    private readonly apiKey: string;
    private readonly readBudget: BudgetReader;

    constructor(options: SuperfluidClientOptions) {
        if (!options?.apiKey) throw new Error("apiKey is required");
        if (!options?.readBudget) throw new Error("readBudget callback is required");
        this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
        this.apiKey = options.apiKey;
        this.readBudget = options.readBudget;
    }

    async executeIfBudgeted(task: string, input: JsonRecord = {}, constraints: JsonRecord = {}): Promise<any> {
        const budget = await this.readBudget();
        if (!budget.active) {
            return {
                ok: false,
                error: "inactive_stream_budget",
                message: "No active Superfluid budget is available for this task.",
                budget,
            };
        }

        const response = await fetch(`${this.baseUrl}/api/execute`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                task,
                input,
                max_cost: budget.maxCost,
                ...constraints,
            }),
        });

        const payload = await parseJson(response);
        return {
            ...payload,
            stream_budget: budget,
        };
    }
}

export default AgoragenticSuperfluidClient;
