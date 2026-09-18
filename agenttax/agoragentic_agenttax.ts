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
  /** This source wrapper currently qualifies single-unit quotes only. */
  units?: 1;
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

export type TaxReviewedExecutionErrorCode =
  | "tax_reviewed_execution_rejected"
  | "tax_reviewed_execution_outcome_unknown";

/**
 * A paid execution did not produce a usable success or pending-approval result.
 * `retryable` is deliberately false: reconcile the quote before any new attempt.
 */
export class TaxReviewedExecutionError extends Error {
  readonly code: TaxReviewedExecutionErrorCode;
  readonly quote_id: string;
  readonly retryable = false;
  readonly reconciliation_path = "/api/commerce/reconciliation";
  readonly http_status?: number;
  readonly server_code?: string;

  constructor(options: {
    code: TaxReviewedExecutionErrorCode;
    quoteId: string;
    httpStatus?: number;
    serverCode?: string;
    cause?: unknown;
  }) {
    const outcome = options.code === "tax_reviewed_execution_outcome_unknown"
      ? "outcome is unknown"
      : "was rejected";
    super(
      `Execution ${outcome} for quote ${options.quoteId}. `
      + "Do not retry or create a new quote until platform activity is reconciled.",
    );
    this.name = "TaxReviewedExecutionError";
    this.code = options.code;
    this.quote_id = options.quoteId;
    this.http_status = options.httpStatus;
    this.server_code = options.serverCode;
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", { value: options.cause, enumerable: false });
    }
  }
}

class AgoragenticRequestError extends Error {
  readonly httpStatus?: number;
  readonly responseReceived: boolean;
  readonly explicitErrorEnvelope: boolean;
  readonly serverCode?: string;

  constructor(options: {
    message: string;
    httpStatus?: number;
    responseReceived: boolean;
    explicitErrorEnvelope?: boolean;
    serverCode?: string;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = "AgoragenticRequestError";
    this.httpStatus = options.httpStatus;
    this.responseReceived = options.responseReceived;
    this.explicitErrorEnvelope = options.explicitErrorEnvelope === true;
    this.serverCode = options.serverCode;
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", { value: options.cause, enumerable: false });
    }
  }
}

interface JsonHttpResponse {
  data: JsonObject;
  httpStatus: number;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertWellFormedUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${path} must not contain an unpaired UTF-16 surrogate.`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`${path} must not contain an unpaired UTF-16 surrogate.`);
    }
  }
}

function defineJsonProperty(target: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function cloneStrictJson(value: unknown, path = "$", active = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    assertWellFormedUnicode(value, path);
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
        const index = typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)
          ? Number(key)
          : Number.NaN;
        if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) {
          throw new TypeError(`${path} must not contain non-index array properties.`);
        }
      }
      const output: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!hasOwn(value, index)) {
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

    const ownKeys = Reflect.ownKeys(value);
    for (const key of ownKeys) {
      if (typeof key !== "string") throw new TypeError(`${path} must not contain symbol keys.`);
      assertWellFormedUnicode(key, `${path} key`);
    }
    const stringKeys = (ownKeys as string[]).sort(compareUtf16);
    const output: JsonObject = {};
    for (const key of stringKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${path}.${key} must be an enumerable data property.`);
      }
      defineJsonProperty(output, key, cloneStrictJson(descriptor.value, `${path}.${key}`, active));
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
    if (key !== "review_payload_sha256") defineJsonProperty(unsignedPayload, key, value);
  }
  return unsignedPayload;
}

/** RFC 8785 JSON Canonicalization Scheme serialization for strict JSON values. */
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("Canonical JSON received a non-JSON value.");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const members = Object.keys(value)
    .sort(compareUtf16)
    .map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError(`Canonical JSON member ${key} is not a data property.`);
      }
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value)}`;
    });
  return `{${members.join(",")}}`;
}

async function sha256Json(value: JsonObject): Promise<string> {
  const canonical = cloneStrictJsonObject(value);
  const bytes = new TextEncoder().encode(canonicalJson(canonical));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compute the RFC 8785/JCS digest an external reviewer must return for this exact payload. */
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
  units: 1;
  taxContext: JsonObject;
} {
  if (!request || typeof request !== "object") {
    throw new TypeError("request must be an object.");
  }
  const capabilityId = requireNonEmptyString(request.capabilityId, "capabilityId");
  const task = requireNonEmptyString(request.task, "task");
  if (!Number.isFinite(request.maxCost) || request.maxCost < 0) {
    throw new TypeError("maxCost must be a finite, non-negative number.");
  }
  const units = request.units ?? 1;
  if (units !== 1) {
    throw new TypeError("This wrapper supports only units: 1.");
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
    if (hasOwn(record, "message") && typeof record.message === "string") return record.message;
    if (hasOwn(record, "error") && typeof record.error === "string") return record.error;
  }
  return "request failed";
}

function responseCode(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  if (hasOwn(record, "error") && typeof record.error === "string") return record.error;
  if (hasOwn(record, "code") && typeof record.code === "string") return record.code;
  return undefined;
}

function parseUsdAmount(value: JsonValue | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) return Number.NaN;
  return Number(value);
}

function validateQuote(
  quoteValue: unknown,
  expectedCapabilityId: string,
  maxCost: number,
  path: string,
  requireFresh = true,
): JsonObject {
  const quote = cloneStrictJsonObject(quoteValue, path);
  requireNonEmptyString(hasOwn(quote, "quote_id") ? quote.quote_id : undefined, `${path}.quote_id`);
  const capability = cloneStrictJsonObject(
    hasOwn(quote, "capability") ? quote.capability : undefined,
    `${path}.capability`,
  );
  if (capability.id !== expectedCapabilityId) {
    throw new Error("Quote capability does not match the requested capability.");
  }
  const quotedPrice = parseUsdAmount(
    hasOwn(quote, "quoted_price_usdc") ? quote.quoted_price_usdc : undefined,
  );
  if (!Number.isFinite(quotedPrice) || quotedPrice < 0 || quotedPrice > maxCost) {
    throw new Error("Quote price is invalid or exceeds maxCost.");
  }
  if (!hasOwn(quote, "units") || quote.units !== 1) {
    throw new Error("Quote units must equal 1.");
  }
  if (!hasOwn(quote, "execution_ready") || quote.execution_ready !== true) {
    throw new Error("Quote is not execution-ready.");
  }
  if (!hasOwn(quote, "preview_only") || quote.preview_only !== false) {
    throw new Error("Quote must not be preview-only.");
  }
  if (!hasOwn(quote, "status") || quote.status !== "ready") {
    throw new Error("Quote status must be ready.");
  }
  const quoteExpiry = hasOwn(quote, "expires_at") && typeof quote.expires_at === "string"
    ? Date.parse(quote.expires_at)
    : Number.NaN;
  if (!Number.isFinite(quoteExpiry)) {
    throw new Error("Quote expiry is missing or invalid.");
  }
  if (requireFresh && quoteExpiry <= Date.now()) {
    throw new Error("Quote is expired.");
  }
  return quote;
}

const REVIEW_QUOTE_FIELDS = [
  "quote_id",
  "preview_only",
  "execution_ready",
  "status",
  "quoted_at",
  "expires_at",
  "commerce_mode",
  "pricing_model",
  "units",
  "unit_price_usdc",
  "quoted_price_usdc",
  "currency",
  "payment_network",
  "payment_asset",
  "settlement_network",
  "settlement_asset",
  "normalization_path",
  "source_amount_usdc",
  "settled_amount_usdc",
] as const;

const REVIEW_CAPABILITY_FIELDS = [
  "id",
  "slug",
  "name",
  "category",
  "listing_type",
  "seller_id",
  "seller_name",
] as const;

function buildReviewQuote(quote: JsonObject): JsonObject {
  const capability = cloneStrictJsonObject(quote.capability, "quote.capability");
  const reviewCapability: JsonObject = {};
  for (const field of REVIEW_CAPABILITY_FIELDS) {
    if (hasOwn(capability, field)) {
      reviewCapability[field] = cloneStrictJson(capability[field], `quote.capability.${field}`);
    }
  }

  const reviewQuote: JsonObject = { capability: reviewCapability };
  for (const field of REVIEW_QUOTE_FIELDS) {
    if (hasOwn(quote, field)) {
      reviewQuote[field] = cloneStrictJson(quote[field], `quote.${field}`);
    }
  }
  return cloneStrictJsonObject(reviewQuote, "reviewQuote");
}

export class AgoragenticAgentTaxClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  readonly #pendingResults = new WeakSet<object>();

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

  private async requestJson(path: string, init: RequestInit, operation: string): Promise<JsonHttpResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      throw new AgoragenticRequestError({
        message: `${operation} failed before a response was received.`,
        responseReceived: false,
        cause,
      });
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (cause) {
      throw new AgoragenticRequestError({
        message: `${operation} returned a non-JSON response.`,
        httpStatus: response.status,
        responseReceived: true,
        cause,
      });
    }
    if (!response.ok) {
      const serverCode = responseCode(data);
      throw new AgoragenticRequestError({
        message: `${operation} failed with HTTP ${response.status}: ${responseMessage(data)}`,
        httpStatus: response.status,
        responseReceived: true,
        explicitErrorEnvelope: serverCode !== undefined,
        serverCode,
      });
    }
    return {
      data: cloneStrictJsonObject(data, `${operation} response`),
      httpStatus: response.status,
    };
  }

  private async createQuote(
    capabilityId: string,
    input: JsonObject,
    units: 1,
    maxCost: number,
  ): Promise<JsonObject> {
    const response = await this.requestJson("/commerce/quotes", {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ capability_id: capabilityId, input, units }),
    }, "Quote creation");
    return validateQuote(
      response.data.quote,
      capabilityId,
      maxCost,
      "Quote creation response.quote",
    );
  }

  private async validateReviewPayload(reviewPayload: JsonObject): Promise<JsonObject> {
    const snapshot = deepFreeze(cloneStrictJsonObject(reviewPayload, "reviewPayload"));
    if (snapshot.schema_version !== "agoragentic.external-review.v1"
      || snapshot.review_type !== "marketplace_purchase") {
      throw new TypeError("reviewPayload has an unsupported schema or review type.");
    }
    if (!hasOwn(snapshot, "review_payload_sha256")
      || typeof snapshot.review_payload_sha256 !== "string") {
      throw new TypeError("reviewPayload.review_payload_sha256 is required.");
    }
    const expectedDigest = await hashTaxReviewPayload(snapshot);
    if (snapshot.review_payload_sha256 !== expectedDigest) {
      throw new TypeError("reviewPayload digest does not match its contents.");
    }
    const capabilityId = requireNonEmptyString(snapshot.capability_id, "reviewPayload.capability_id");
    if (typeof snapshot.max_cost_usdc !== "number"
      || !Number.isFinite(snapshot.max_cost_usdc)
      || snapshot.max_cost_usdc < 0) {
      throw new TypeError("reviewPayload.max_cost_usdc must be a finite, non-negative number.");
    }
    if (snapshot.units !== 1) throw new TypeError("reviewPayload.units must equal 1.");
    requireNonEmptyString(snapshot.task, "reviewPayload.task");
    cloneStrictJsonObject(snapshot.input, "reviewPayload.input");
    cloneStrictJsonObject(snapshot.tax_context, "reviewPayload.tax_context");
    validateQuote(
      snapshot.quote,
      capabilityId,
      snapshot.max_cost_usdc,
      "reviewPayload.quote",
      false,
    );
    return snapshot;
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
      capability_id: validated.capabilityId,
      task: validated.task,
      input: validated.input,
      max_cost_usdc: validated.maxCost,
      units: validated.units,
      quote: buildReviewQuote(quote),
      tax_context: validated.taxContext,
    });
    const reviewPayload = cloneStrictJsonObject({
      ...unsignedPayload,
      review_payload_sha256: await sha256Json(unsignedPayload),
    });
    return deepFreeze(reviewPayload);
  }

  /** Prepare, externally review, and execute one durable quote. */
  async executeWithTaxReview(
    request: TaxReviewedExecutionRequest,
    reviewTaxCallback: TaxReviewCallback,
  ): Promise<JsonObject> {
    const reviewPayload = await this.prepareTaxReview(request);
    const review = await reviewTaxCallback(reviewPayload);
    return this.#executeApprovedTaxReview(reviewPayload, review);
  }

  async #executeApprovedTaxReview(
    reviewPayload: JsonObject,
    review: TaxReviewDecision,
  ): Promise<JsonObject> {
    const payloadSnapshot = await this.validateReviewPayload(reviewPayload);
    const reviewRecord = cloneStrictJsonObject(review, "review");
    const expectedPayloadHash = payloadSnapshot.review_payload_sha256;
    const expiresAt = typeof reviewRecord.expires_at === "string"
      ? Date.parse(reviewRecord.expires_at)
      : Number.NaN;
    const requiredApprovalFieldsAreOwn = [
      "approved",
      "status",
      "review_id",
      "review_payload_sha256",
      "expires_at",
    ].every((field) => hasOwn(reviewRecord, field));
    const invalidApproval = !requiredApprovalFieldsAreOwn
      || reviewRecord.status !== "approved"
      || reviewRecord.approved !== true
      || typeof reviewRecord.review_id !== "string"
      || !reviewRecord.review_id.trim()
      || reviewRecord.review_payload_sha256 !== expectedPayloadHash
      || !Number.isFinite(expiresAt)
      || expiresAt <= Date.now();

    const quote = cloneStrictJsonObject(payloadSnapshot.quote, "reviewPayload.quote");
    const quoteId = requireNonEmptyString(quote.quote_id, "reviewPayload.quote.quote_id");
    if (invalidApproval) {
      return cloneStrictJsonObject({
        status: "blocked",
        quote_id: quoteId,
        message: hasOwn(reviewRecord, "reason") && typeof reviewRecord.reason === "string"
          ? reviewRecord.reason
          : reviewRecord.status === "advisory"
            ? "Advisory tax review cannot authorize execution."
            : "Tax review approval was missing, expired, or not bound to this payload.",
        review: reviewRecord,
        review_payload: payloadSnapshot,
      });
    }

    const quoteExpiresAt = typeof quote.expires_at === "string"
      ? Date.parse(quote.expires_at)
      : Number.NaN;
    if (!Number.isFinite(quoteExpiresAt) || quoteExpiresAt <= Date.now()) {
      return cloneStrictJsonObject({
        status: "blocked",
        quote_id: quoteId,
        message: "The reviewed quote expired before execution.",
        review: reviewRecord,
        review_payload: payloadSnapshot,
      });
    }
    const task = requireNonEmptyString(payloadSnapshot.task, "reviewPayload.task");
    const input = cloneStrictJsonObject(payloadSnapshot.input, "reviewPayload.input");

    let response: JsonHttpResponse;
    try {
      response = await this.requestJson("/execute", {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({ quote_id: quoteId, task, input }),
      }, "Quote execution");
    } catch (cause) {
      const requestError = cause instanceof AgoragenticRequestError ? cause : undefined;
      const definitiveRejection = requestError?.responseReceived === true
        && requestError.explicitErrorEnvelope
        && requestError.httpStatus !== undefined
        && requestError.httpStatus >= 400
        && requestError.httpStatus < 500;
      throw new TaxReviewedExecutionError({
        code: definitiveRejection
          ? "tax_reviewed_execution_rejected"
          : "tax_reviewed_execution_outcome_unknown",
        quoteId,
        httpStatus: requestError?.httpStatus,
        serverCode: requestError?.serverCode,
        cause,
      });
    }

    const execution = response.data;
    const hasExecutionError = hasOwn(execution, "error");
    const rawExecutionError = hasExecutionError ? execution.error : undefined;
    const executionError = typeof rawExecutionError === "string"
      ? rawExecutionError
      : undefined;
    const rawExecutionStatus = hasOwn(execution, "status") ? execution.status : undefined;
    const normalizedStatus = typeof rawExecutionStatus === "string"
      ? rawExecutionStatus.toLowerCase()
      : undefined;
    const pendingApproval = executionError === "pending_approval"
      || normalizedStatus === "pending_approval";
    const rejectedStatus = normalizedStatus !== undefined
      && ["failed", "failure", "error", "rejected", "cancelled", "canceled"].includes(normalizedStatus);
    const successfulStatus = normalizedStatus === "success" || normalizedStatus === "completed";
    const malformedError = hasExecutionError
      && rawExecutionError !== null
      && rawExecutionError !== undefined
      && typeof rawExecutionError !== "string";
    const hasExecutionSuccess = hasOwn(execution, "success");
    const executionSuccess = hasExecutionSuccess ? execution.success : undefined;
    const malformedSuccessFlag = hasExecutionSuccess
      && typeof executionSuccess !== "boolean";
    const contradictoryEnvelope = (pendingApproval
      && normalizedStatus !== undefined
      && normalizedStatus !== "pending_approval")
      || (normalizedStatus === "pending_approval"
        && executionError !== undefined
        && executionError !== "pending_approval")
      || (executionError !== undefined
        && executionError !== "pending_approval"
        && successfulStatus)
      || (executionSuccess === false && !rejectedStatus)
      || (executionSuccess === true && rejectedStatus);
    if (malformedError || malformedSuccessFlag || contradictoryEnvelope) {
      throw new TaxReviewedExecutionError({
        code: "tax_reviewed_execution_outcome_unknown",
        quoteId,
        httpStatus: response.httpStatus,
        serverCode: malformedError || malformedSuccessFlag
          ? "malformed_execution_response"
          : "contradictory_execution_envelope",
      });
    }
    if ((executionError && executionError !== "pending_approval") || rejectedStatus) {
      throw new TaxReviewedExecutionError({
        code: "tax_reviewed_execution_rejected",
        quoteId,
        httpStatus: response.httpStatus,
        serverCode: executionError || `execution_${normalizedStatus}`,
      });
    }
    if (pendingApproval) {
      let approvalId: string | undefined;
      const topLevelApprovalId = hasOwn(execution, "approval_id")
        ? execution.approval_id
        : undefined;
      if (typeof topLevelApprovalId === "string" && topLevelApprovalId.trim()) {
        approvalId = topLevelApprovalId.trim();
      }
      const nestedApproval = hasOwn(execution, "approval") ? execution.approval : undefined;
      if (!approvalId && nestedApproval && typeof nestedApproval === "object"
        && !Array.isArray(nestedApproval)) {
        const approval = cloneStrictJsonObject(nestedApproval, "execution.approval");
        const rawApprovalId = approval.approval_id ?? approval.id;
        if (typeof rawApprovalId === "string" && rawApprovalId.trim()) {
          approvalId = rawApprovalId.trim();
        }
      }
      if (!approvalId) {
        throw new TaxReviewedExecutionError({
          code: "tax_reviewed_execution_outcome_unknown",
          quoteId,
          httpStatus: response.httpStatus,
          serverCode: "malformed_pending_approval",
        });
      }
    } else if (normalizedStatus !== "success" && normalizedStatus !== "completed") {
      throw new TaxReviewedExecutionError({
        code: "tax_reviewed_execution_outcome_unknown",
        quoteId,
        httpStatus: response.httpStatus,
        serverCode: normalizedStatus
          ? `unexpected_execution_status_${normalizedStatus}`
          : "malformed_execution_response",
      });
    } else if (!hasOwn(execution, "invocation_id")
      || typeof execution.invocation_id !== "string"
      || !execution.invocation_id.trim()) {
      throw new TaxReviewedExecutionError({
        code: "tax_reviewed_execution_outcome_unknown",
        quoteId,
        httpStatus: response.httpStatus,
        serverCode: "missing_invocation_id",
      });
    }

    const result = deepFreeze(cloneStrictJsonObject({
      quote_id: quoteId,
      http_status: response.httpStatus,
      execution_state: pendingApproval ? "pending_approval" : "returned",
      review: reviewRecord,
      review_payload: payloadSnapshot,
      execution,
    }));
    if (pendingApproval) this.#pendingResults.add(result);
    return result;
  }

  /** Retry one opaque in-memory `pending_approval` result after supervisor approval. */
  async retryPendingTaxReview(pendingResult: JsonObject): Promise<JsonObject> {
    if (!this.#pendingResults.has(pendingResult)) {
      throw new TypeError("pendingResult is not an active result issued by this client.");
    }
    this.#pendingResults.delete(pendingResult);
    const result = cloneStrictJsonObject(pendingResult, "pendingResult");
    const execution = cloneStrictJsonObject(result.execution, "pendingResult.execution");
    const pendingApproval = result.execution_state === "pending_approval"
      && (execution.error === "pending_approval"
        || execution.status === "pending_approval");
    if (!pendingApproval) {
      throw new TypeError("pendingResult is not a pending_approval execution result.");
    }
    const reviewPayload = cloneStrictJsonObject(
      result.review_payload,
      "pendingResult.review_payload",
    );
    const quote = cloneStrictJsonObject(reviewPayload.quote, "pendingResult.review_payload.quote");
    const reviewedQuoteId = requireNonEmptyString(
      quote.quote_id,
      "pendingResult.review_payload.quote.quote_id",
    );
    if (result.quote_id !== reviewedQuoteId) {
      throw new TypeError("pendingResult quote_id does not match its reviewed quote.");
    }
    const review = cloneStrictJsonObject(result.review, "pendingResult.review");
    return this.#executeApprovedTaxReview(
      reviewPayload,
      review as unknown as TaxReviewDecision,
    );
  }
}

export default AgoragenticAgentTaxClient;
