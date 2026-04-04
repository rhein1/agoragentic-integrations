/**
 * Agoragentic x AgentTax
 *
 * Honest boundary:
 * - AgentTax is treated as the tax and compliance review layer around a planned spend.
 * - Agoragentic still handles routing, execution, and settlement.
 * - This wrapper does not claim native tax filing or remittance inside Agoragentic.
 */

type JsonObject = Record<string, unknown>;

interface AgentTaxClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface TaxReviewContext {
  jurisdiction?: string;
  buyerEntity?: string;
  sellerEntity?: string;
  memo?: string;
  tags?: string[];
}

type TaxReviewCallback = (reviewPayload: JsonObject) => Promise<{
  approved: boolean;
  review_id?: string;
  classification?: string;
  reason?: string;
}>;

export class AgoragenticAgentTaxClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AgentTaxClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || "https://agoragentic.com/api";
    this.fetchImpl = options.fetchImpl || fetch;
  }

  private authHeaders(): HeadersInit {
    if (!this.apiKey) {
      throw new Error("AGORAGENTIC_API_KEY is required for tax-reviewed execute flows.");
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

  async prepareTaxReview(
    task: string,
    input: JsonObject,
    maxCost: number,
    taxContext: TaxReviewContext = {}
  ): Promise<JsonObject> {
    const preview = await this.match(task, maxCost);
    return {
      review_type: "marketplace_purchase",
      task,
      input,
      preview,
      tax_context: {
        jurisdiction: taxContext.jurisdiction || null,
        buyer_entity: taxContext.buyerEntity || null,
        seller_entity: taxContext.sellerEntity || null,
        memo: taxContext.memo || null,
        tags: taxContext.tags || []
      }
    };
  }

  async executeWithTaxReview(
    task: string,
    input: JsonObject,
    maxCost: number,
    reviewTaxCallback: TaxReviewCallback,
    taxContext: TaxReviewContext = {}
  ): Promise<JsonObject> {
    const reviewPayload = await this.prepareTaxReview(task, input, maxCost, taxContext);
    const review = await reviewTaxCallback(reviewPayload);

    if (!review.approved) {
      return {
        status: "blocked",
        message: review.reason || "AgentTax review rejected the spend.",
        review,
        review_payload: reviewPayload
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
      review,
      execution: await response.json()
    };
  }
}

export default AgoragenticAgentTaxClient;
