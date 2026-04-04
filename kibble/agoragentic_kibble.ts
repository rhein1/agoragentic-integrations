/**
 * Agoragentic x Kibble
 *
 * Honest boundary:
 * - Kibble is used to fund a buyer wallet from any chain or token.
 * - Agoragentic still handles routing, execution, and settlement on its own stack.
 * - This wrapper generates Kibble funding links and pairs them with router previews.
 */

type JsonValue = Record<string, unknown>;

interface KibbleClientOptions {
  apiKey?: string;
  baseUrl?: string;
  kibbleBaseUrl?: string;
  defaultDestinationChain?: number;
  defaultDestinationToken?: string;
  defaultDestinationAddress?: string;
  agentName?: string;
  fetchImpl?: typeof fetch;
}

interface FundingRequest {
  toChain?: number;
  toToken?: string;
  toAddress?: string;
  toAmount?: number;
  agentName?: string;
  note?: string;
  returnUrl?: string;
}

export class AgoragenticKibbleClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly kibbleBaseUrl: string;
  private readonly defaultDestinationChain: number;
  private readonly defaultDestinationToken?: string;
  private readonly defaultDestinationAddress?: string;
  private readonly agentName?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: KibbleClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || "https://agoragentic.com/api";
    this.kibbleBaseUrl = options.kibbleBaseUrl || "https://www.kibble.sh";
    this.defaultDestinationChain = options.defaultDestinationChain || 8453;
    this.defaultDestinationToken = options.defaultDestinationToken;
    this.defaultDestinationAddress = options.defaultDestinationAddress;
    this.agentName = options.agentName;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async match(task: string, maxCost = 1): Promise<JsonValue> {
    if (!this.apiKey) {
      throw new Error("AGORAGENTIC_API_KEY is required for authenticated execute/match previews.");
    }
    const url = new URL(`${this.baseUrl}/execute/match`);
    url.searchParams.set("task", task);
    url.searchParams.set("max_cost", String(maxCost));

    const response = await this.fetchImpl(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      }
    });
    return response.json();
  }

  buildFundingUrl(request: FundingRequest = {}): string {
    const params = new URLSearchParams();
    params.set("toChain", String(request.toChain || this.defaultDestinationChain));
    params.set("toToken", request.toToken || this.defaultDestinationToken || "");
    params.set("toAddress", request.toAddress || this.defaultDestinationAddress || "");

    const agentName = request.agentName || this.agentName;
    if (agentName) params.set("agentName", agentName);
    if (typeof request.toAmount === "number") params.set("toAmount", String(request.toAmount));
    if (request.note) params.set("note", request.note);
    if (request.returnUrl) params.set("returnUrl", request.returnUrl);

    return `${this.kibbleBaseUrl}/?${params.toString()}`;
  }

  async planFunding(task: string, input: JsonValue, maxCost: number, funding: FundingRequest = {}): Promise<JsonValue> {
    const preview = await this.match(task, maxCost);
    return {
      mode: "fund_then_execute",
      preview,
      input,
      funding_url: this.buildFundingUrl(funding),
      destination: {
        chain_id: funding.toChain || this.defaultDestinationChain,
        token: funding.toToken || this.defaultDestinationToken,
        address: funding.toAddress || this.defaultDestinationAddress
      }
    };
  }
}

export default AgoragenticKibbleClient;
