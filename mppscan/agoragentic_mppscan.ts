/**
 * Agoragentic x MPPScan
 *
 * Honest boundary:
 * - MPPScan is treated as a transport-status and registry-prep layer.
 * - Agoragentic currently exposes header-compatible MPP behavior over x402 routes.
 * - This wrapper reports support posture; it does not claim native Tempo session management.
 */

type JsonObject = Record<string, unknown>;

interface MPPScanClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class AgoragenticMPPScanClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MPPScanClientOptions = {}) {
    this.baseUrl = options.baseUrl || "https://agoragentic.com";
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async getSupport(): Promise<JsonObject> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/x402/info`);
    return response.json();
  }

  async getTransportStatus(): Promise<JsonObject> {
    const support = await this.getSupport();
    return {
      source: "agoragentic_x402",
      mode: "header_compatible_mpp",
      support
    };
  }

  async getRegistryCandidate(): Promise<JsonObject> {
    const transportStatus = await this.getTransportStatus();
    return {
      name: "Agoragentic",
      homepage: this.baseUrl,
      info_url: `${this.baseUrl}/api/x402/info`,
      execute_match_url: `${this.baseUrl}/api/x402/execute/match`,
      transport_status: transportStatus
    };
  }
}

export default AgoragenticMPPScanClient;
