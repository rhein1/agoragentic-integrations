/**
 * Agoragentic helpers for Cloudflare Agents / Workers.
 *
 * Use these functions from an Agent, Worker route, or AI SDK tool wrapper when
 * the edge agent needs routed external work plus receipts.
 */

export type AgoragenticConstraints = {
  max_cost?: number;
  category?: string;
  approval_required?: boolean;
};

export type AgoragenticExecuteInput = {
  task: string;
  input?: Record<string, unknown>;
  constraints?: AgoragenticConstraints;
};

export class AgoragenticCloudflareClient {
  readonly baseUrl: string;
  readonly apiKey?: string;

  constructor(options: { apiKey?: string; baseUrl?: string } = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl || "https://agoragentic.com").replace(/\/$/, "");
  }

  private headers() {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async match(task: string, constraints: AgoragenticConstraints = {}) {
    const params = new URLSearchParams({ task });
    if (constraints.max_cost !== undefined) params.set("max_cost", String(constraints.max_cost));
    if (constraints.category) params.set("category", constraints.category);
    const response = await fetch(`${this.baseUrl}/api/execute/match?${params}`, {
      headers: this.headers(),
    });
    return response.json();
  }

  async execute({ task, input = {}, constraints = {} }: AgoragenticExecuteInput) {
    const response = await fetch(`${this.baseUrl}/api/execute`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ task, input, constraints }),
    });
    return response.json();
  }

  async status(invocationId: string) {
    const response = await fetch(`${this.baseUrl}/api/execute/status/${invocationId}`, {
      headers: this.headers(),
    });
    return response.json();
  }

  async receipt(receiptId: string) {
    const response = await fetch(`${this.baseUrl}/api/commerce/receipts/${receiptId}`, {
      headers: this.headers(),
    });
    return response.json();
  }
}

export function createAgoragenticCloudflareTools(apiKey?: string) {
  const client = new AgoragenticCloudflareClient({ apiKey });
  return {
    agoragentic_match: {
      description: "Preview Agoragentic providers before spending.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string" },
          max_cost: { type: "number" },
          category: { type: "string" },
        },
        required: ["task"],
      },
      execute: async ({ task, max_cost, category }: { task: string; max_cost?: number; category?: string }) =>
        client.match(task, { max_cost, category }),
    },
    agoragentic_execute: {
      description: "Route paid work through Agoragentic and return status/receipt metadata.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string" },
          input: { type: "object" },
          max_cost: { type: "number" },
        },
        required: ["task"],
      },
      execute: async ({ task, input, max_cost }: { task: string; input?: Record<string, unknown>; max_cost?: number }) =>
        client.execute({ task, input, constraints: max_cost === undefined ? {} : { max_cost } }),
    },
  };
}
