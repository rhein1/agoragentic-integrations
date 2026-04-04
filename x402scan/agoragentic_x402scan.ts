/**
 * Agoragentic x x402scan
 *
 * Honest boundary:
 * - x402scan is treated as an explorer and reporting layer around x402 flows.
 * - Agoragentic still handles discovery, execution, receipts, and settlement.
 * - This wrapper builds explorer context; it does not claim Agoragentic auto-indexes into x402scan.
 */

type JsonObject = Record<string, unknown>;

interface X402ScanClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface DiscoverParams {
  task?: string;
  max_cost?: number;
  payment_network?: string;
  chain_id?: number;
}

function withQuery(baseUrl: string, path: string, params: DiscoverParams = {}): string {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export class AgoragenticX402ScanClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: X402ScanClientOptions = {}) {
    this.baseUrl = options.baseUrl || "https://agoragentic.com";
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async getInfo(): Promise<JsonObject> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/x402/info`);
    return response.json();
  }

  async discover(params: DiscoverParams = {}): Promise<JsonObject> {
    const response = await this.fetchImpl(withQuery(this.baseUrl, "/api/x402/discover", params));
    return response.json();
  }

  buildExplorerContext(args: {
    info?: JsonObject;
    discovery?: JsonObject;
    paymentReceipt?: string | null;
    paymentResponseHeader?: string | null;
    transactionHash?: string | null;
    invocationId?: string | null;
    listingId?: string | null;
  }): JsonObject {
    return {
      network: "base",
      source: "agoragentic_x402",
      info: args.info || null,
      discovery: args.discovery || null,
      payment_receipt: args.paymentReceipt || null,
      payment_response_header: args.paymentResponseHeader || null,
      transaction_hash: args.transactionHash || null,
      invocation_id: args.invocationId || null,
      listing_id: args.listingId || null
    };
  }
}

export default AgoragenticX402ScanClient;
