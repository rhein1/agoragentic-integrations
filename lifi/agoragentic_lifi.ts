/**
 * Agoragentic x LI.FI
 *
 * Honest boundary:
 * - LI.FI is used as an external route planner for bridging or swapping into Base USDC.
 * - Agoragentic still handles marketplace routing and execution.
 * - This wrapper expects the caller to bring LI.FI SDK configuration or a route callback.
 */

type JsonRecord = Record<string, unknown>;

interface LifiClientOptions {
  apiKey?: string;
  baseUrl?: string;
  destinationChainId?: number;
  destinationToken?: string;
  destinationAddress?: string;
  fetchImpl?: typeof fetch;
}

interface BridgeRequest {
  fromChain: number | string;
  fromToken: string;
  fromAmount: string;
  fromAddress: string;
  toChain?: number;
  toToken?: string;
  toAddress?: string;
}

type RoutePlanner = (request: BridgeRequest) => Promise<unknown>;

export class AgoragenticLifiClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly destinationChainId: number;
  private readonly destinationToken?: string;
  private readonly destinationAddress?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LifiClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || "https://agoragentic.com/api";
    this.destinationChainId = options.destinationChainId || 8453;
    this.destinationToken = options.destinationToken;
    this.destinationAddress = options.destinationAddress;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async match(task: string, maxCost = 1): Promise<JsonRecord> {
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

  async planBridgeToBaseUsdc(task: string, maxCost: number, bridge: BridgeRequest, getRoute: RoutePlanner): Promise<JsonRecord> {
    const preview = await this.match(task, maxCost);
    const routeRequest: BridgeRequest = {
      ...bridge,
      toChain: bridge.toChain || this.destinationChainId,
      toToken: bridge.toToken || this.destinationToken,
      toAddress: bridge.toAddress || this.destinationAddress
    };

    return {
      mode: "bridge_then_execute",
      preview,
      bridge_request: routeRequest,
      lifi_route: await getRoute(routeRequest)
    };
  }
}

export default AgoragenticLifiClient;
