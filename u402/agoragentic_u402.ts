/**
 * Agoragentic x u402
 *
 * Honest boundary:
 * - u402 is treated as a private-payment support checker around x402-compatible routes.
 * - Agoragentic still exposes public x402 challenge-response flows today.
 * - This wrapper keeps x402 fallback explicit instead of claiming native private settlement.
 */

type JsonObject = Record<string, unknown>;

type U402PaymentResult = {
  authorizationHeader?: string;
  paymentSignature?: string;
  receipt?: unknown;
};

type U402PaymentHandler = (paymentRequired: string, request: {
  url: string;
  method: string;
  body: JsonObject;
}) => Promise<U402PaymentResult>;

interface U402ClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  payChallenge?: U402PaymentHandler;
}

function buildQuery(params: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const qs = query.toString();
  return qs ? `?${qs}` : "";
}

async function parseJson(response: Response): Promise<JsonObject> {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

export class AgoragenticU402Client {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly payChallenge?: U402PaymentHandler;

  constructor(options: U402ClientOptions = {}) {
    this.baseUrl = options.baseUrl || "https://agoragentic.com";
    this.fetchImpl = options.fetchImpl || fetch;
    this.payChallenge = options.payChallenge;
  }

  async getSupport(): Promise<JsonObject> {
    const support = await this.fetchImpl(`${this.baseUrl}/api/x402/info`).then(parseJson);
    return {
      source: "agoragentic_x402",
      private_payments_supported: false,
      fallback_mode: "x402",
      support
    };
  }

  async preview(task: string, constraints: JsonObject = {}): Promise<JsonObject> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/x402/execute/match${buildQuery({ task, ...constraints })}`
    );
    return parseJson(response);
  }

  async executeQuote(quoteId: string, input: JsonObject = {}): Promise<JsonObject> {
    const requestBody = { quote_id: quoteId, input };
    const initial = await this.fetchImpl(`${this.baseUrl}/api/x402/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });

    if (initial.status !== 402) {
      return parseJson(initial);
    }
    if (!this.payChallenge) {
      throw new Error("payChallenge callback is required when retrying a PAYMENT-REQUIRED flow.");
    }

    const paymentRequired = initial.headers.get("PAYMENT-REQUIRED");
    if (!paymentRequired) {
      throw new Error("Missing PAYMENT-REQUIRED header");
    }

    const payment = await this.payChallenge(paymentRequired, {
      url: `${this.baseUrl}/api/x402/execute`,
      method: "POST",
      body: requestBody
    });

    const retryHeaders: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (payment.authorizationHeader) retryHeaders.Authorization = payment.authorizationHeader;
    if (payment.paymentSignature) retryHeaders["PAYMENT-SIGNATURE"] = payment.paymentSignature;

    const settled = await this.fetchImpl(`${this.baseUrl}/api/x402/execute`, {
      method: "POST",
      headers: retryHeaders,
      body: JSON.stringify(requestBody)
    });

    return {
      ...(await parseJson(settled)),
      payment_receipt: settled.headers.get("Payment-Receipt"),
      payment_response_header: settled.headers.get("PAYMENT-RESPONSE"),
      u402_receipt: payment.receipt || null
    };
  }
}

export default AgoragenticU402Client;
