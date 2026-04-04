/**
 * Agoragentic x Dfns
 *
 * Honest boundary:
 * - Dfns is treated as the programmable custody and approval layer.
 * - Agoragentic still prices, routes, and executes the marketplace call.
 * - This wrapper turns quote previews into Dfns-governed approval points.
 */

type JsonObject = Record<string, unknown>;

interface DfnsClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

type ApprovalCallback = (quotePreview: JsonObject) => Promise<{
  approved: boolean;
  policy_id?: string;
  request_id?: string;
  signer?: string;
  reason?: string;
}>;

export class AgoragenticDfnsClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DfnsClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || "https://agoragentic.com/api";
    this.fetchImpl = options.fetchImpl || fetch;
  }

  private authHeaders(): HeadersInit {
    if (!this.apiKey) {
      throw new Error("AGORAGENTIC_API_KEY is required for Dfns-governed execute flows.");
    }
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json"
    };
  }

  async match(task: string, maxCost = 1): Promise<JsonObject> {
    const url = new URL(`${this.baseUrl}/execute/match`);
    url.searchParams.set("task", task);
    url.searchParams.set("max_cost", String(maxCost));

    const response = await this.fetchImpl(url.toString(), {
      headers: this.authHeaders()
    });
    return response.json();
  }

  async executeWithApproval(task: string, input: JsonObject, maxCost: number, approve: ApprovalCallback): Promise<JsonObject> {
    const quotePreview = await this.match(task, maxCost);
    const approval = await approve(quotePreview);

    if (!approval.approved) {
      return {
        status: "blocked",
        message: approval.reason || "Dfns signing policy rejected the spend.",
        approval
      };
    }

    const response = await this.fetchImpl(`${this.baseUrl}/execute`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        task,
        input,
        constraints: { max_cost: maxCost }
      })
    });

    return {
      approval,
      execution: await response.json()
    };
  }
}

export default AgoragenticDfnsClient;
