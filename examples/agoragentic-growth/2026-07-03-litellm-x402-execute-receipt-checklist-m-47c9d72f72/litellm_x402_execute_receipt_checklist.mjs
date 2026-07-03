import crypto from "node:crypto";

const DEFAULT_BASE_URL = "https://agoragentic.com";
const MATCH_PATH = "/api/match";
const EXECUTE_PATH = "/api/execute";

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
    "../lib/x402-client.mjs",
    "../../lib/x402-client.mjs",
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
  const paymentResponse = readHeader(response, "payment-response");
  const paymentAttempted = Boolean(response?.x402Meta?.paymentAttempted || paymentReceipt || paymentResponse);
  const invocationId = payload?.invocation_id ?? payload?.invocationId ?? payload?.result?.id ?? null;
  const receiptId = payload?.receipt_id ?? payload?.receipt?.receipt_id ?? null;
  const settlement = payload?.settlement ?? payload?.receipt?.settlement ?? null;

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
      status: paymentAttempted ? (paymentReceipt ? "pass" : "warn") : "skip",
      evidence: paymentAttempted ? (paymentReceipt ?? "header missing") : "no payment challenge observed",
    },
    {
      item: "receipt_reference_present",
      status: receiptId ? "pass" : "warn",
      evidence: receiptId ?? "response omitted receipt_id",
    },
    {
      item: "invocation_reference_present",
      status: invocationId ? "pass" : "warn",
      evidence: invocationId ?? "response omitted invocation reference",
    },
    {
      item: "settlement_state_is_informational_only",
      status: settlement ? "pass" : "skip",
      evidence: settlement ?? "settlement field absent",
      note: settlement ? "Treat broadcast/submitted settlement as informational until independently verified." : undefined,
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
    paymentReceipt,
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
    this.x402FetchPromise = resolveX402Fetch(options.x402Fetch);

    if (typeof this.fetchImpl !== "function") {
      throw new Error("fetchImpl is required");
    }
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

  async fetchManifest() {
    const manifestCandidates = [
      "/.well-known/x402/manifest",
      "/.well-known/x402-manifest.json",
      "/api/x402/manifest",
    ];

    const attempts = [];
    for (const path of manifestCandidates) {
      const response = await this.fetchImpl(buildUrl(this.baseUrl, path), {
        method: "GET",
        headers: { accept: "application/json" },
      });
      const payload = await readJsonResponse(response);
      attempts.push({ path, status: response.status, payload: payload.json });
      if (response.ok) {
        return {
          source: path,
          manifest: payload.json,
          attempts,
        };
      }
    }

    return {
      source: null,
      manifest: null,
      attempts,
    };
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

    const x402Fetch = await this.x402FetchPromise;
    const resolvedTask = task ?? `litellm.chat.completions.${model ?? "unknown"}`;
    const matchPayload = quoteId ? null : await this.match({ task: resolvedTask, constraints });
    const resolvedQuoteId = quoteId ?? matchPayload?.quote_id ?? matchPayload?.quote?.quote_id ?? null;
    if (!resolvedQuoteId) {
      throw new Error("execute() requires quote_id from options.quoteId or match()");
    }

    const response = await x402Fetch(buildUrl(this.baseUrl, EXECUTE_PATH), {
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

export function createLocalX402Fetch() {
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
        const paymentRequiredHeader = readHeader(response, "payment-required");
        if (!paymentRequiredHeader) {
          throw new Error("Received HTTP 402 without payment-required header");
        }
        if (typeof pay !== "function") {
          throw new Error("Paid call requires a caller-supplied pay callback");
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
        if (paymentAuthorized && networkRetriesUsed < maxNetworkRetries) {
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
  const manifestBody = {
    version: "0.1",
    network: "base",
    endpoints: [
      {
        path: EXECUTE_PATH,
        method: "POST",
        payment_required: true,
        asset: "USDC",
      },
    ],
  };

  async function fetchImpl(url, init = {}) {
    const target = typeof url === "string" ? new URL(url) : new URL(url.toString());
    const path = target.pathname;
    const method = String(init.method || "GET").toUpperCase();
    const headers = lowerCaseHeaders(init.headers || {});

    if (
      (path === "/.well-known/x402/manifest" || path === "/.well-known/x402-manifest.json" || path === "/api/x402/manifest") &&
      method === "GET"
    ) {
      return new SimpleResponse(200, { "content-type": "application/json" }, manifestBody);
    }

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

  const manifest = await client.fetchManifest();
  if (manifest.source !== "/.well-known/x402/manifest") {
    throw new Error(`Expected manifest discovery to use /.well-known/x402/manifest, got ${manifest.source}`);
  }

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

  return {
    ok: true,
    manifestSource: manifest.source,
    manifest,
    quoteId: result.quoteId,
    idempotencyKey: result.idempotencyKey,
    payCalls: stats.payCalls,
    executeAttempts: stats.executeAttempts,
    receiptChecklist: result.receiptChecklist,
    modelResponse: result.modelResponse,
    retryGuidance: result.retryGuidance,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSelfTest()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}
