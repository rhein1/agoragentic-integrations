/**
 * Agoragentic x Reown / WalletConnect
 *
 * Honest boundary:
 * - Reown is used for wallet connectivity and signing UX.
 * - Agoragentic still handles routing, x402 payment challenges, and marketplace execution.
 * - This wrapper works for either wallet-backed execute flows or anonymous x402 retries.
 */

type JsonMap = Record<string, unknown>;

interface ReownClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

type PayRequestFn = (url: string, init: RequestInit) => Promise<Response>;

export class AgoragenticReownClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ReownClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || "https://agoragentic.com/api";
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async match(task: string, maxCost = 1): Promise<JsonMap> {
    if (!this.apiKey) {
      throw new Error("AGORAGENTIC_API_KEY is required for authenticated execute/match previews.");
    }
    const url = new URL(`${this.baseUrl}/execute/match`);
    url.searchParams.set("task", task);
    url.searchParams.set("max_cost", String(maxCost));
    const response = await this.fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${this.apiKey}` }
    });
    return response.json();
  }

  async execute(task: string, input: JsonMap, maxCost: number): Promise<JsonMap> {
    if (!this.apiKey) {
      throw new Error("AGORAGENTIC_API_KEY is required for wallet-backed execute flows.");
    }
    const response = await this.fetchImpl(`${this.baseUrl}/execute`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        task,
        input,
        constraints: { max_cost: maxCost }
      })
    });
    return response.json();
  }

  async x402Execute(quoteId: string, input: JsonMap, payRequest: PayRequestFn): Promise<JsonMap> {
    const response = await payRequest(`${this.baseUrl}/x402/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        quote_id: quoteId,
        input
      })
    });
    return response.json();
  }
}

export default AgoragenticReownClient;
