/**
 * Agoragentic external review callback wrapper (AgentTax example).
 *
 * Honest boundary:
 * - The caller supplies and authenticates the external tax or compliance reviewer.
 * - Agoragentic creates the durable quote, executes that exact quote, and settles it.
 * - This source-only wrapper does not call AgentTax or prove AgentTax identity.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface AgentTaxClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface TaxReviewContext {
  buyerJurisdiction?: string;
  sellerJurisdiction?: string;
  /** @deprecated This legacy value is applied to both buyer and seller. */
  jurisdiction?: string;
  buyerEntity?: string;
  sellerEntity?: string;
  memo?: string;
  tags?: string[];
}

export interface TaxReviewedExecutionRequest {
  capabilityId: string;
  task: string;
  input: JsonObject;
  maxCost: number;
  units?: number;
  taxContext?: TaxReviewContext;
}

export interface ApprovedTaxReview {
  approved: true;
  status: "approved";
  review_id: string;
  review_payload_sha256: string;
  expires_at: string;
  classification?: string;
  reason?: string;
}

export interface NonApprovedTaxReview {
  approved: false;
  status: "denied" | "advisory";
  review_id?: string;
  review_payload_sha256?: string;
  expires_at?: string;
  classification?: string;
  reason?: string;
}

export type TaxReviewDecision = ApprovedTaxReview | NonApprovedTaxReview;
export type TaxReviewCallback = (
  reviewPayload: Readonly<JsonObject>,
) => Promise<TaxReviewDecision>;

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cloneStrictJson(value: unknown, path = "$", active = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite JSON numbers.`);
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} must contain only JSON-compatible values.`);
  }
  if (active.has(value)) throw new TypeError(`${path} must not contain a circular reference.`);
  active.add(value);

  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) {
          throw new TypeError(`${path} must not contain non-index array properties.`);
        }
      }
      const output: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError(`${path}[${index}] must not be a sparse array slot.`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new TypeError(`${path}[${index}] must be an enumerable data property.`);
        }
        output.push(cloneStrictJson(descriptor.value, `${path}[${index}]`, active));
      }
      return output;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must be a plain JSON object.`);
    }

    const output: JsonObject = {};
    for (const key of Reflect.ownKeys(value).sort((left, right) => {
      if (typeof left !== "string" || typeof right !== "string") return 0;
      return compareUtf16(left, right);
    })) {
      if (typeof key !== "string") throw new TypeError(`${path} must not contain symbol keys.`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${path}.${key} must be an enumerable data property.`);
      }
      output[key] = cloneStrictJson(descriptor.value, `${path}.${key}`, active);
    }
    return output;
  } finally {
    active.delete(value);
  }
}

function cloneStrictJsonObject(value: unknown, path = "$"): JsonObject {
  const cloned = cloneStrictJson(value, path);
  if (cloned === null || Array.isArray(cloned) || typeof cloned !== "object") {
    throw new TypeError(`${path} must be a JSON object.`);
  }
  return cloned;
}

function deepFreeze<T extends JsonValue>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function withoutPayloadDigest(payload: JsonObject): JsonObject {
  const unsignedPayload: JsonObject = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key !== "review_payload_sha256") unsignedPayload[key] = value;
  }
  return unsignedPayload;
}

async function sha256Json(value: JsonObject): Promise<string> {
  const canonical = cloneStrictJsonObject(value);
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compute the digest an external reviewer must return for this exact payload. */
export async function hashTaxReviewPayload(payload: JsonObject): Promise<string> {
  const canonicalPayload = cloneStrictJsonObject(payload, "reviewPayload");
  return sha256Json(withoutPayloadDigest(canonicalPayload));
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalTrimmedString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requireNonEmptyString(value, field);
}

function normalizeTaxContext(context: TaxReviewContext = {}): JsonObject {
  const legacy = optionalTrimmedString(context.jurisdiction, "taxContext.jurisdiction");
  const explicitBuyer = optionalTrimmedString(context.buyerJurisdiction, "taxContext.buyerJurisdiction");
  const explicitSeller = optionalTrimmedString(context.sellerJurisdiction, "taxContext.sellerJurisdiction");

  if (legacy && explicitBuyer && legacy !== explicitBuyer) {
    throw new TypeError("taxContext.jurisdiction conflicts with taxContext.buyerJurisdiction.");
  }
  if (legacy && explicitSeller && legacy !== explicitSeller) {
    throw new TypeError("taxContext.jurisdiction conflicts with taxContext.sellerJurisdiction.");
  }

  const tags = context.tags ?? [];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string" || !tag.trim())) {
    throw new TypeError("taxContext.tags must contain only non-empty strings.");
  }

  return cloneStrictJsonObject({
    buyer_jurisdiction: explicitBuyer ?? legacy,
    seller_jurisdiction: explicitSeller ?? legacy,
    buyer_entity: optionalTrimmedString(context.buyerEntity, "taxContext.buyerEntity"),
    seller_entity: optionalTrimmedString(context.sellerEntity, "taxContext.sellerEntity"),
    memo: optionalTrimmedString(context.memo, "taxContext.memo"),
    tags: tags.map((tag) => tag.trim()),
  });
}

function validateRequest(request: TaxReviewedExecutionRequest): {
  capabilityId: string;
  task: string;
  input: JsonObject;
  maxCost: number;
  units: number;
  taxContext: JsonObject;
} {
  const capabilityId = requireNonEmptyString(request.capabilityId, "capabilityId");
  const task = requireNonEmptyString(request.task, "task");
  if (!Number.isFinite(request.maxCost) || request.maxCost < 0) {
    throw new TypeError("maxCost must be a finite, non-negative number.");
  }
  const units = request.units ?? 1;
  if (!Number.isSafeInteger(units) || units <= 0) {
    throw new TypeError("units must be a positive safe integer.");
  }
  return {
    capabilityId,
    task,
    input: cloneStrictJsonObject(request.input, "input"),
    maxCost: request.maxCost,
    units,
    taxContext: normalizeTaxContext(request.taxContext),
  };
}

function responseMessage(data: unknown): string {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
  }
  return "request failed";
}

function parseUsdAmount(value: JsonValue | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) return Number.NaN;
  return Number(value);
}

export class AgoragenticAgentTaxClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AgentTaxClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl || "https://agoragentic.com/api").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl || fetch;
  }

  private authHeaders(): HeadersInit {
    if (!this.apiKey) {
      throw new Error("AGORAGENTIC_API_KEY is required for tax-reviewed quote and execute flows.");
    }
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  private async requestJson(path: string, init: RequestInit, operation: string): Promise<JsonObject> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error(`${operation} returned a non-JSON response.`);
    }
    if (!response.ok) {
      throw new Error(`${operation} failed with HTTP ${response.status}: ${responseMessage(data)}`);
    }
    return cloneStrictJsonObject(data, `${operation} response`);
  }

  private async createQuote(
    capabilityId: string,
    input: JsonObject,
    units: number,
    maxCost: number,
  ): Promise<JsonObject> {
    const envelope = await this.requestJson("/commerce/quotes", {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ capability_id: capabilityId, input, units }),
    }, "Quote creation");

    const quote = cloneStrictJsonObject(envelope.quote, "Quote creation response.quote");
    requireNonEmptyString(quote.quote_id, "quote.quote_id");
    const capability = cloneStrictJsonObject(quote.capability, "quote.capability");
    if (capability.id !== capabilityId) {
      throw new Error("Quote capability does not match the requested capability.");
    }
    const quotedPrice = parseUsdAmount(quote.quoted_price_usdc);
    if (!Number.isFinite(quotedPrice) || quotedPrice < 0 || quotedPrice > maxCost) {
      throw new Error("Quote price is invalid or exceeds maxCost.");
    }
    if (quote.execution_ready !== true) {
      throw new Error("Quote is not execution-ready.");
    }
    const quoteExpiry = typeof quote.expires_at === "string" ? Date.parse(quote.expires_at) : Number.NaN;
    if (!Number.isFinite(quoteExpiry) || quoteExpiry <= Date.now()) {
      throw new Error("Quote expiry is missing, invalid, or expired.");
    }
    return quote;
  }

  /** Create a no-spend, quote-bound packet for an external reviewer. */
  async prepareTaxReview(request: TaxReviewedExecutionRequest): Promise<JsonObject> {
    const validated = validateRequest(request);
    const quote = await this.createQuote(
      validated.capabilityId,
      validated.input,
      validated.units,
      validated.maxCost,
    );
    const unsignedPayload = cloneStrictJsonObject({
      schema_version: "agoragentic.external-review.v1",
      review_type: "marketplace_purchase",
      task: validated.task,
      input: validated.input,
      max_cost_usdc: validated.maxCost,
      units: validated.units,
      quote,
      tax_context: validated.taxContext,
    });
    const reviewPayload = cloneStrictJsonObject({
      ...unsignedPayload,
      review_payload_sha256: await sha256Json(unsignedPayload),
    });
    return deepFreeze(reviewPayload);
  }

  /** Execute only the exact durable quote approved by the external reviewer. */
  async executeWithTaxReview(
    request: TaxReviewedExecutionRequest,
    reviewTaxCallback: TaxReviewCallback,
  ): Promise<JsonObject> {
    const reviewPayload = await this.prepareTaxReview(request);
    const review = await reviewTaxCallback(reviewPayload);
    const reviewRecord = cloneStrictJsonObject(review, "review");

    const expectedPayloadHash = await hashTaxReviewPayload(reviewPayload);
    const expiresAt = typeof reviewRecord.expires_at === "string"
      ? Date.parse(reviewRecord.expires_at)
      : Number.NaN;
    const invalidApproval = reviewRecord.status !== "approved"
      || reviewRecord.approved !== true
      || typeof reviewRecord.review_id !== "string"
      || !reviewRecord.review_id.trim()
      || reviewRecord.review_payload_sha256 !== expectedPayloadHash
      || !Number.isFinite(expiresAt)
      || expiresAt <= Date.now();

    if (invalidApproval) {
      return cloneStrictJsonObject({
        status: "blocked",
        message: typeof reviewRecord.reason === "string"
          ? reviewRecord.reason
          : reviewRecord.status === "advisory"
            ? "Advisory tax review cannot authorize execution."
            : "Tax review approval was missing, expired, or not bound to this payload.",
        review: reviewRecord,
        review_payload: reviewPayload,
      });
    }

    const quote = cloneStrictJsonObject(reviewPayload.quote, "reviewPayload.quote");
    const quoteId = requireNonEmptyString(quote.quote_id, "reviewPayload.quote.quote_id");
    const quoteExpiresAt = typeof quote.expires_at === "string"
      ? Date.parse(quote.expires_at)
      : Number.NaN;
    if (!Number.isFinite(quoteExpiresAt) || quoteExpiresAt <= Date.now()) {
      return cloneStrictJsonObject({
        status: "blocked",
        message: "The reviewed quote expired before execution.",
        review: reviewRecord,
        review_payload: reviewPayload,
      });
    }
    const task = requireNonEmptyString(reviewPayload.task, "reviewPayload.task");
    const input = cloneStrictJsonObject(reviewPayload.input, "reviewPayload.input");
    const execution = await this.requestJson("/execute", {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ quote_id: quoteId, task, input }),
    }, "Quote execution");

    return cloneStrictJsonObject({ review: reviewRecord, review_payload: reviewPayload, execution });
  }
}

export default AgoragenticAgentTaxClient;
