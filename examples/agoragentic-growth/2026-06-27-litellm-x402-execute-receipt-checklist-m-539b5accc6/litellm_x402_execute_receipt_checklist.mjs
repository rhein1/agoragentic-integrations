// demo — moves no real funds
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://agoragentic.com";
const MATCH_PATH = "/api/x402/execute/match";
const EXECUTE_PATH = "/api/x402/execute";

function stableId(prefix = "x402") {
  return `${prefix}_${crypto.randomUUID()}`;
}

function lowerCaseHeaders(headers = {}) {
  const entries = headers instanceof Headers ? Array.from(headers.entries()) : Object.entries(headers || {});
  return Object.fromEntries(entries.map(([key, value]) => [String(key).toLowerCase(), value]));
}

function readHeader(response, name) {
  if (!response?.headers) {
    return null;
  }
  if (typeof response.headers.get === "function") {
    return response.headers.get(name) ?? response.headers.get(String(name).toLowerCase()) ?? null;
  }
  const headers = lowerCaseHeaders(response.headers);
  return headers[String(name).toLowerCase()] ?? null;
}

function readAnyHeader(response, ...names) {
  for (const name of names) {
    const value = readHeader(response, name);
    if (value) return value;
  }
  return null;
}

function buildUrl(baseUrl, path, query = null) {
  const url = new URL(path, baseUrl);
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function safeJsonParse(text, fallback = null) {
  if (text === null || text === undefined || text === "") {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function readJsonResponse(response) {
  const text = typeof response.text === "function" ? await response.text() : "";
  return {
    text,
    json: safeJsonParse(text, {}),
  };
}

async function resolveX402Fetch(candidate) {
  if (typeof candidate === "function") {
    return candidate;
  }

  const importCandidates = [
    "agoragentic/x402-client",
    "../x402/x402_receipt_validation_adapter.mjs",
    "../lib/x402-client.mjs",
  ];

  for (const specifier of importCandidates) {
    try {
      const mod = await import(specifier);
      if (typeof mod.x402Fetch === "function") {
        return mod.x402Fetch;
      }
    } catch {
      // Try the next location.
    }
  }

  throw new Error("Unable to load x402Fetch. Install the agoragentic package or provide options.x402Fetch.");
}

function extractAssistantText(payload) {
  const fromChoices = payload?.choices?.find((choice) => typeof choice?.message?.content === "string")?.message?.content;
  if (fromChoices) {
    return fromChoices;
  }
  const fromResultChoices = payload?.result?.choices?.find((choice) => typeof choice?.message?.content === "string")?.message?.content;
  if (fromResultChoices) {
    return fromResultChoices;
  }
  if (typeof payload?.output_text === "string") {
    return payload.output_text;
  }
  if (typeof payload?.result?.output_text === "string") {
    return payload.result.output_text;
  }
  if (typeof payload?.result?.text === "string") {
    return payload.result.text;
  }
  if (typeof payload?.text === "string") {
    return payload.text;
  }
  return null;
}

function normalizeLiteLLMResponse(payload, fallbackModel) {
  if (payload?.choices && Array.isArray(payload.choices)) {
    return payload;
  }

  if (payload?.result?.choices && Array.isArray(payload.result.choices)) {
    return {
      id: payload.result.id ?? payload.invocation_id ?? stableId("chatcmpl"),
      object: payload.result.object ?? "chat.completion",
      created: payload.result.created ?? Math.floor(Date.now() / 1000),
      model: payload.result.model ?? fallbackModel ?? "unknown",
      choices: payload.result.choices,
      usage: payload.result.usage ?? null,
    };
  }

  const text = extractAssistantText(payload) ?? JSON.stringify(payload?.result ?? payload ?? {});
  return {
    id: payload?.id ?? payload?.invocation_id ?? stableId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: payload?.model ?? payload?.result?.model ?? fallbackModel ?? "unknown",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: text,
        },
      },
    ],
    usage: payload?.usage ?? payload?.result?.usage ?? null,
  };
}

function buildReceiptChecklist({ response, payload, quoteId, idempotencyKey }) {
  const paymentReceipt = readHeader(response, "payment-receipt");
  const paymentResponse = readAnyHeader(response, "payment-response", "x-payment-response");
  const effectivePaymentReceipt = paymentReceipt || readHeader(response, "x-payment-receipt");
  const paymentAttempted = Boolean(response?.x402Meta?.paymentAttempted || effectivePaymentReceipt || paymentResponse);
  const invocationId = payload?.invocation_id ?? payload?.invocationId ?? null;
  const receiptId = payload?.receipt_id ?? payload?.receipt?.receipt_id ?? payload?.receipt?.id ?? effectivePaymentReceipt ?? null;
  const settlement = payload?.settlement ?? payload?.receipt?.settlement ?? null;
  const returnedQuoteId = payload?.quote_id ?? payload?.quoteId ?? payload?.receipt?.quote_id ?? payload?.receipt?.quoteId ?? null;
  const quoteMatches = !returnedQuoteId || !quoteId || returnedQuoteId === quoteId;
  const failedSettlement = typeof settlement === "string" && ["failed", "error", "cancelled", "canceled", "rejected"].includes(settlement.toLowerCase());

  const checks = [
    {
      item: "idempotency_key_present",
      status: idempotencyKey ? "pass" : "fail",
      evidence: idempotencyKey ?? "missing",
    },
    {
      item: "402_triggered_before_pay",
      status: paymentAttempted ? "pass" : "warn",
      evidence: paymentAttempted ? "payment challenge observed" : "no payment challenge observed during this run",
    },
    {
      item: "payment_receipt_header_present",
      status: paymentAttempted ? (effectivePaymentReceipt ? "pass" : "fail") : "skip",
      evidence: paymentAttempted ? (effectivePaymentReceipt ?? "header missing") : "no payment challenge observed",
    },
    {
      item: "receipt_reference_present",
      status: receiptId ? "pass" : (paymentAttempted ? "fail" : "warn"),
      evidence: receiptId ?? "response omitted receipt_id",
    },
    {
      item: "invocation_reference_present",
      status: invocationId ? "pass" : "warn",
      evidence: invocationId ?? "response omitted invocation reference",
    },
    {
      item: "settlement_state_is_informational_only",
      status: failedSettlement ? "fail" : (settlement ? "pass" : "skip"),
      evidence: settlement ?? "settlement field absent",
      note: settlement ? "Treat broadcast/submitted settlement as informational until independently verified." : undefined,
    },
    {
      item: "quote_binding",
      status: quoteMatches ? "pass" : "fail",
      evidence: returnedQuoteId ? `${returnedQuoteId} vs ${quoteId ?? "missing"}` : "no returned quote id",
    },
    {
      item: "quote_reference_present",
      status: quoteId ? "pass" : "warn",
      evidence: quoteId ?? "quote_id missing",
    },
  ];

  return {
    ok: checks.every((check) => check.status !== "fail"),
    paymentAttempted,
    paymentReceipt: effectivePaymentReceipt,
    paymentResponse,
    quoteId,
    idempotencyKey,
    invocationId,
    receiptId,
    settlement,
    checks,
    residualUncertainty: [
      "Buyer-side receipt checks confirm transport evidence only.",
      "A payment receipt header is not independent settlement proof.",
      "Retry safety depends on reusing the same idempotency key and payment authorization.",
    ],
  };
}

export class LiteLLMX402ExecuteReceiptChecklist {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.apiKey = options.apiKey ?? process.env.AGORAGENTIC_API_KEY ?? null;
    this.defaultPay = options.pay;
    this.idempotencyKeyFactory = options.idempotencyKeyFactory ?? (() => stableId("litellm-x402"));
    this.x402FetchCandidate = options.x402Fetch;
    this.x402FetchImpl = null;

    if (typeof this.fetchImpl !== "function") {
      throw new Error("fetchImpl is required");
    }
  }

  async getX402Fetch() {
    if (!this.x402FetchImpl) {
      this.x402FetchImpl = await resolveX402Fetch(this.x402FetchCandidate);
    }
    return this.x402FetchImpl;
  }

  defaultHeaders() {
    const headers = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async match({ task, constraints = {} }) {
    const response = await this.fetchImpl(buildUrl(this.baseUrl, MATCH_PATH, { task, ...constraints }), {
      method: "GET",
      headers: this.defaultHeaders(),
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(`match() failed with HTTP ${response.status}: ${payload.text}`);
    }
    return payload.json;
  }

  async execute(request = {}) {
    const {
      task,
      model,
      messages = [],
      input = {},
      metadata = {},
      constraints = {},
      quoteId,
      pay = this.defaultPay,
      idempotencyKey = this.idempotencyKeyFactory(),
      signal,
    } = request;

    const x402Fetch = await this.getX402Fetch();
    const resolvedTask = task ?? `litellm.chat.completions.${model ?? "unknown"}`;
    const matchPayload = quoteId ? null : await this.match({ task: resolvedTask, constraints });
    const resolvedQuoteId = quoteId ?? matchPayload?.quote_id ?? matchPayload?.quote?.quote_id ?? null;
    if (!resolvedQuoteId) {
      throw new Error("execute() requires quote_id from options.quoteId or match()");
    }

    let response;
    try {
      response = await x402Fetch(buildUrl(this.baseUrl, EXECUTE_PATH), {
        fetchImpl: this.fetchImpl,
        pay,
        idempotencyKey,
        method: "POST",
        signal,
        headers: this.defaultHeaders(),
        body: {
          quote_id: resolvedQuoteId,
          input: {
            model,
            messages,
            metadata,
            ...input,
          },
        },
        maxNetworkRetries: 1,
      });
    } catch (error) {
      if (error && typeof error === "object" && !error.idempotencyKey) {
        error.idempotencyKey = idempotencyKey;
      }
      throw error;
    }

    const payload = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(`execute() failed with HTTP ${response.status}: ${payload.text}`);
    }

    const modelResponse = normalizeLiteLLMResponse(payload.json, model);
    const receiptChecklist = buildReceiptChecklist({
      response,
      payload: payload.json,
      quoteId: resolvedQuoteId,
      idempotencyKey,
    });

    return {
      task: resolvedTask,
      quoteId: resolvedQuoteId,
      idempotencyKey,
      match: matchPayload,
      payload: payload.json,
      modelResponse,
      outputText: extractAssistantText(modelResponse),
      x402: response.x402Meta ?? null,
      receiptChecklist,
      retryGuidance: {
        when: "network error after payment authorization or a transport-level timeout",
        action: "retry the same call with the same idempotency key and reuse the existing payment authorization",
      },
    };
  }
}

class SimpleHeaders {
  constructor(init = {}) {
    this.map = new Map(Object.entries(lowerCaseHeaders(init)));
  }

  get(name) {
    return this.map.get(String(name).toLowerCase()) ?? null;
  }

  entries() {
    return this.map.entries();
  }
}

class SimpleResponse {
  constructor(status, headers = {}, jsonBody = {}) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.headers = new SimpleHeaders(headers);
    this._body = JSON.stringify(jsonBody);
    this.x402Meta = null;
  }

  async text() {
    return this._body;
  }
}

function attachX402Meta(response, meta) {
  response.x402Meta = {
    ...(response.x402Meta || {}),
    ...meta,
  };
  return response;
}

function challengeFingerprint(paymentRequiredHeader, request) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      paymentRequiredHeader,
      url: request.url,
      method: request.method,
      body: request.body,
      idempotencyKey: request.idempotencyKey,
    }))
    .digest("hex");
}

function createLocalX402Fetch() {
  return async function x402Fetch(url, options = {}) {
    const {
      fetchImpl = globalThis.fetch,
      pay,
      idempotencyKey,
      method = "POST",
      headers = {},
      body,
      signal,
      maxNetworkRetries = 1,
    } = options;

    if (typeof fetchImpl !== "function") {
      throw new Error("fetchImpl is required");
    }
    if (!idempotencyKey) {
      throw new Error("idempotencyKey is required");
    }

    const baseHeaders = {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      ...lowerCaseHeaders(headers),
    };

    let paymentAuthorized = null;
    let sawPaymentChallenge = false;
    let networkRetriesUsed = 0;

    for (;;) {
      const requestHeaders = { ...baseHeaders };
      if (paymentAuthorized?.authorizationHeader) {
        requestHeaders.authorization = paymentAuthorized.authorizationHeader;
      }
      if (paymentAuthorized?.paymentSignature) {
        requestHeaders["payment-signature"] = paymentAuthorized.paymentSignature;
      }

      try {
        const response = await fetchImpl(url, {
          method,
          headers: requestHeaders,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });

        if (response.status !== 402) {
          return attachX402Meta(response, {
            paymentAttempted: sawPaymentChallenge,
            paymentAuthorized: Boolean(paymentAuthorized),
            authorizedPaymentReused: Boolean(paymentAuthorized),
            networkRetriesUsed,
            idempotencyKey,
          });
        }

        sawPaymentChallenge = true;
        if (paymentAuthorized) {
          const error = new Error("Paid retry was rejected with HTTP 402; refusing to reuse rejected payment authorization");
          error.idempotencyKey = idempotencyKey;
          error.paymentAttempted = true;
          throw error;
        }
        const paymentRequiredHeader = readAnyHeader(response, "payment-required", "x-payment-required");
        if (!paymentRequiredHeader) {
          const error = new Error("Received HTTP 402 without payment-required header");
          error.idempotencyKey = idempotencyKey;
          throw error;
        }
        if (typeof pay !== "function") {
          const error = new Error("Paid call requires a caller-supplied pay callback");
          error.idempotencyKey = idempotencyKey;
          throw error;
        }
        if (!paymentAuthorized) {
          paymentAuthorized = await pay(paymentRequiredHeader, {
            url,
            method,
            body,
            idempotencyKey,
            headers: { ...baseHeaders },
            challengeFingerprint: challengeFingerprint(paymentRequiredHeader, {
              url,
              method,
              body,
              idempotencyKey,
            }),
          });
        }
      } catch (error) {
        if (error && typeof error === "object" && !error.idempotencyKey) {
          error.idempotencyKey = idempotencyKey;
        }
        if (paymentAuthorized && !error?.paymentAttempted && networkRetriesUsed < maxNetworkRetries) {
          networkRetriesUsed += 1;
          continue;
        }
        throw error;
      }
    }
  };
}

export function createMockLiteLLMTransport() {
  let executeAttempts = 0;
  let payCalls = 0;
  let firstPaidRetryDrops = true;
  const seenIdempotencyKeys = [];
  const seenAuthHeaders = [];

  async function fetchImpl(url, init = {}) {
    const target = typeof url === "string" ? new URL(url) : new URL(url.toString());
    const path = target.pathname;
    const method = String(init.method || "GET").toUpperCase();
    const headers = lowerCaseHeaders(init.headers || {});

    if (path === MATCH_PATH && method === "GET") {
      return new SimpleResponse(200, { "content-type": "application/json" }, {
        quote_id: "quote_litellm_demo_001",
        match: {
          provider: "demo-provider",
          price_usdc: 0.03,
          receipt_supported: true,
        },
      });
    }

    if (path === EXECUTE_PATH && method === "POST") {
      executeAttempts += 1;
      seenIdempotencyKeys.push(headers["idempotency-key"] ?? null);
      if (headers.authorization) {
        seenAuthHeaders.push(headers.authorization);
      }

      if (!headers.authorization && !headers["payment-signature"]) {
        return new SimpleResponse(402, {
          "payment-required": JSON.stringify({
            type: "x402",
            network: "base",
            asset: "USDC",
            max_amount_usdc: "0.03",
            pay_to: "demo:merchant",
          }),
        }, {
          error: "payment_required",
          quote_id: "quote_litellm_demo_001",
        });
      }

      if (firstPaidRetryDrops) {
        firstPaidRetryDrops = false;
        throw new Error("simulated transient network drop after payment authorization");
      }

      const body = safeJsonParse(init.body, {});
      return new SimpleResponse(200, {
        "content-type": "application/json",
        "payment-receipt": "receipt_demo_litellm_001",
        "payment-response": "paid",
      }, {
        success: true,
        quote_id: body.quote_id,
        invocation_id: "inv_demo_litellm_001",
        receipt_id: "rcpt_demo_litellm_001",
        settlement: "submitted",
        result: {
          id: "chatcmpl_demo_litellm_001",
          object: "chat.completion",
          created: 1735689600,
          model: body.input?.model ?? "gpt-4o-mini",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: `demo — moves no real funds — echoed: ${body.input?.messages?.[0]?.content ?? ""}`,
              },
            },
          ],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 11,
            total_tokens: 19,
          },
        },
      });
    }

    return new SimpleResponse(404, { "content-type": "application/json" }, { error: "not_found", path, method });
  }

  async function pay(paymentRequiredHeader, request) {
    payCalls += 1;
    return {
      authorizationHeader: `X402 demo-authorization ${request.challengeFingerprint}`,
      paymentSignature: `demo-signature-${crypto.createHash("sha256").update(paymentRequiredHeader).digest("hex").slice(0, 16)}`,
      receipt: {
        demo: true,
        note: "Self-test only. No real wallet or funds movement.",
      },
    };
  }

  return {
    fetchImpl,
    pay,
    stats() {
      return {
        executeAttempts,
        payCalls,
        seenIdempotencyKeys,
        seenAuthHeaders,
      };
    },
  };
}

export async function runSelfTest() {
  const mock = createMockLiteLLMTransport();
  const client = new LiteLLMX402ExecuteReceiptChecklist({
    baseUrl: DEFAULT_BASE_URL,
    fetchImpl: mock.fetchImpl,
    pay: mock.pay,
    x402Fetch: createLocalX402Fetch(),
    idempotencyKeyFactory: () => "litellm-demo-idem-001",
  });

  const result = await client.execute({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Summarize retry safety." }],
    metadata: { integration: "litellm" },
  });

  const stats = mock.stats();
  if (stats.payCalls !== 1) {
    throw new Error(`Expected pay() to be called once, got ${stats.payCalls}`);
  }
  if (stats.executeAttempts !== 3) {
    throw new Error(`Expected three execute attempts (402 + paid retry + network retry), got ${stats.executeAttempts}`);
  }
  if (new Set(stats.seenIdempotencyKeys).size !== 1 || stats.seenIdempotencyKeys[0] !== "litellm-demo-idem-001") {
    throw new Error(`Expected one stable idempotency key, got ${JSON.stringify(stats.seenIdempotencyKeys)}`);
  }
  if (new Set(stats.seenAuthHeaders).size !== 1) {
    throw new Error(`Expected payment authorization reuse, got ${JSON.stringify(stats.seenAuthHeaders)}`);
  }
  if (result.receiptChecklist.paymentReceipt !== "receipt_demo_litellm_001") {
    throw new Error("Expected payment receipt header evidence");
  }
  if (result.payload.settlement !== "submitted") {
    throw new Error("Expected settlement to remain informational as submitted");
  }
  if (!String(result.outputText).includes("retry safety")) {
    throw new Error(`Expected output text to include echoed request, got ${result.outputText}`);
  }

  const noReceiptChecklist = buildReceiptChecklist({
    response: attachX402Meta(new SimpleResponse(200, { "payment-response": "paid" }, { success: true }), {
      paymentAttempted: true,
    }),
    payload: { success: true, quote_id: "quote_litellm_demo_001" },
    quoteId: "quote_litellm_demo_001",
    idempotencyKey: "litellm-no-receipt",
  });
  if (noReceiptChecklist.ok) {
    throw new Error("Expected paid checklist without receipt evidence to fail");
  }

  const failedSettlementChecklist = buildReceiptChecklist({
    response: attachX402Meta(new SimpleResponse(200, {
      "payment-receipt": "receipt_failed_demo",
      "payment-response": "paid",
    }, {}), { paymentAttempted: true }),
    payload: {
      quote_id: "quote_litellm_demo_001",
      invocation_id: "inv_failed_demo",
      receipt_id: "rcpt_failed_demo",
      settlement: "failed",
    },
    quoteId: "quote_litellm_demo_001",
    idempotencyKey: "litellm-failed-settlement",
  });
  if (failedSettlementChecklist.ok) {
    throw new Error("Expected failed settlement state to fail the checklist");
  }

  const mismatchedQuoteChecklist = buildReceiptChecklist({
    response: attachX402Meta(new SimpleResponse(200, {
      "payment-receipt": "receipt_quote_mismatch",
      "payment-response": "paid",
    }, {}), { paymentAttempted: true }),
    payload: {
      quote_id: "quote_other",
      invocation_id: "inv_quote_mismatch",
      receipt_id: "rcpt_quote_mismatch",
      settlement: "submitted",
    },
    quoteId: "quote_litellm_demo_001",
    idempotencyKey: "litellm-quote-mismatch",
  });
  if (mismatchedQuoteChecklist.ok) {
    throw new Error("Expected returned quote mismatch to fail the checklist");
  }

  const modelIdOnlyChecklist = buildReceiptChecklist({
    response: new SimpleResponse(200, { "content-type": "application/json" }, {}),
    payload: { result: { id: "chatcmpl_model_response_only" } },
    quoteId: "quote_litellm_demo_001",
    idempotencyKey: "litellm-model-id-only",
  });
  if (modelIdOnlyChecklist.invocationId !== null) {
    throw new Error("Model response ids must not be treated as invocation ids");
  }

  const localX402Fetch = createLocalX402Fetch();
  let paid402Attempts = 0;
  let paid402PayCalls = 0;
  try {
    await localX402Fetch(`${DEFAULT_BASE_URL}${EXECUTE_PATH}`, {
      fetchImpl: async (_url, init = {}) => {
        paid402Attempts += 1;
        const headers = lowerCaseHeaders(init.headers || {});
        return new SimpleResponse(402, {
          "payment-required": JSON.stringify({ type: "x402", quote_id: "quote_litellm_demo_001" }),
        }, {
          error: headers.authorization ? "paid_retry_rejected" : "payment_required",
        });
      },
      pay: async () => {
        paid402PayCalls += 1;
        return { authorizationHeader: "X402 demo-authorization paid-reject" };
      },
      idempotencyKey: "litellm-paid-402-idem",
      body: { quote_id: "quote_litellm_demo_001" },
    });
    throw new Error("Expected repeated paid 402 to fail closed");
  } catch (error) {
    if (!String(error.message).includes("Paid retry was rejected")) {
      throw error;
    }
    if (error.idempotencyKey !== "litellm-paid-402-idem") {
      throw new Error(`Expected idempotency key on paid 402 error, got ${error.idempotencyKey}`);
    }
    if (paid402Attempts !== 2 || paid402PayCalls !== 1) {
      throw new Error(`Expected one authorization and two attempts, got attempts=${paid402Attempts} payCalls=${paid402PayCalls}`);
    }
  }

  const generatedKeyClient = new LiteLLMX402ExecuteReceiptChecklist({
    baseUrl: DEFAULT_BASE_URL,
    fetchImpl: mock.fetchImpl,
    x402Fetch: async () => {
      throw new Error("simulated x402 transport failure");
    },
    idempotencyKeyFactory: () => "litellm-generated-error-key",
  });
  try {
    await generatedKeyClient.execute({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "fail after generated key" }],
      quoteId: "quote_litellm_demo_001",
    });
    throw new Error("Expected x402 transport failure");
  } catch (error) {
    if (!String(error.message).includes("simulated x402 transport failure")) {
      throw error;
    }
    if (error.idempotencyKey !== "litellm-generated-error-key") {
      throw new Error(`Expected generated idempotency key on thrown error, got ${error.idempotencyKey}`);
    }
  }

  return {
    ok: true,
    quoteId: result.quoteId,
    idempotencyKey: result.idempotencyKey,
    payCalls: stats.payCalls,
    executeAttempts: stats.executeAttempts,
    receiptChecklist: result.receiptChecklist,
    modelResponse: result.modelResponse,
    retryGuidance: result.retryGuidance,
    regressionAssertions: {
      paidChecklistRequiresReceiptEvidence: true,
      failedSettlementFailsChecklist: true,
      quoteMismatchFailsChecklist: true,
      modelIdsAreNotInvocationIds: true,
      repeatedPaid402FailsClosed: true,
      generatedIdempotencyKeySurfacedOnErrors: true,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSelfTest()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}
