#!/usr/bin/env node
// demo — self-test moves no real funds; the pay() callback below returns mock authorization only.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_BASE_URL = process.env.AGORAGENTIC_URL || "https://agoragentic.com";
const EXECUTE_PATH = "/api/x402/execute";
const RECEIPT_PATH = (receiptId) => `/api/commerce/receipts/${encodeURIComponent(receiptId)}`;
const PROOF_PATH = (invocationId) => `/api/x402/invocations/${encodeURIComponent(invocationId)}/proof`;
const TERMINAL_PROOF_STATUSES = new Set(["settled", "confirmed", "finalized", "complete", "completed"]);
const SUBMITTED_PROOF_STATUSES = new Set(["submitted", "broadcast", "pending", "processing"]);

function lowerCaseHeaders(input = {}) {
  if (input instanceof Headers) {
    return Object.fromEntries(Array.from(input.entries(), ([key, value]) => [String(key).toLowerCase(), value]));
  }
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [String(key).toLowerCase(), value]));
}

function readHeader(source, name) {
  if (!source) return null;
  const wanted = String(name).toLowerCase();
  if (typeof source.get === "function") {
    return source.get(name) ?? source.get(wanted) ?? null;
  }
  const headers = lowerCaseHeaders(source.headers || source);
  return headers[wanted] ?? null;
}

function buildUrl(baseUrl, path) {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function decodeStructuredValue(raw) {
  if (!raw || typeof raw !== "string") return null;
  const attempts = [raw.trim()];
  try {
    attempts.push(Buffer.from(raw.trim(), "base64").toString("utf8"));
  } catch {}
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return null;
}

function parsePaymentRequired(raw) {
  const decoded = decodeStructuredValue(raw);
  if (Array.isArray(decoded)) return decoded;
  if (decoded && Array.isArray(decoded.challenges)) return decoded.challenges;
  return [];
}

function extractInvocationId(payload) {
  return payload?.invocation_id ?? payload?.invocationId ?? null;
}

function extractReceiptId(payload, response = null) {
  return payload?.receipt_id
    ?? payload?.receipt?.receipt_id
    ?? payload?.receipt?.id
    ?? readHeader(response, "payment-receipt")
    ?? null;
}

function extractChallengeId(challenge) {
  return challenge?.challenge_id
    ?? challenge?.challengeId
    ?? challenge?.nonce
    ?? challenge?.payment_id
    ?? challenge?.paymentId
    ?? null;
}

function extractPaymentId(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value.payment_id ?? value.paymentId ?? value.authorization_id ?? value.authorizationId ?? null;
}

function classifyProof(proof) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return "missing";
  const status = String(proof.status ?? proof?.on_chain?.status ?? "").toLowerCase();
  if (TERMINAL_PROOF_STATUSES.has(status)) return "terminal";
  if (SUBMITTED_PROOF_STATUSES.has(status)) return "submitted";
  return status ? `other:${status}` : "unknown";
}

function classifyThrownError(error) {
  if (typeof error?.status === "number") return "http_error";
  if (error?.name === "NetworkError") return "network_error";
  if (error?.name === "AbortError") return "abort_error";
  return "unknown_error";
}

function createExecuteError(message, extra = {}) {
  const error = new Error(message);
  error.name = extra.name || "KeryxAgoragenticExecuteError";
  Object.assign(error, extra);
  return error;
}

let cachedX402FetchPromise = null;
async function loadX402Fetch() {
  if (!cachedX402FetchPromise) {
    cachedX402FetchPromise = (async () => {
      try {
        const preferred = await import("agoragentic/x402-client");
        if (typeof preferred.x402Fetch === "function") {
          return preferred.x402Fetch;
        }
      } catch {}

      const fallback = await import("../x402/x402-receipt-validation-adapter.mjs");
      if (typeof fallback.x402FetchWithFallback === "function") {
        return fallback.x402FetchWithFallback;
      }

      throw new Error("Unable to load x402Fetch from agoragentic/x402-client or ../x402/x402-receipt-validation-adapter.mjs");
    })();
  }
  return cachedX402FetchPromise;
}

async function ensureOkJson(fetchImpl, url, init, label) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw createExecuteError(`${label} request failed: ${error.message}`, {
      name: "NetworkError",
      cause: error,
      url,
    });
  }
  const payload = await safeJson(response);
  if (!response.ok) {
    throw createExecuteError(`${label} request failed with HTTP ${response.status}`, {
      status: response.status,
      payload,
      url,
    });
  }
  return payload;
}

function buildChecklist(result) {
  const proofClass = classifyProof(result.proof);
  const paymentChallengeId = extractChallengeId(result.paidChallenge);
  const paymentResponseId = extractPaymentId(result.paymentResponse);
  return [
    {
      item: "idempotency_key_sent",
      ok: typeof result.idempotencyKey === "string" && result.idempotencyKey.length > 0,
      evidence: result.idempotencyKey,
    },
    {
      item: "http_success",
      ok: result.responseStatus >= 200 && result.responseStatus < 300,
      evidence: { status: result.responseStatus },
    },
    {
      item: "payment_authorized_only_after_402",
      ok: result.x402?.paymentAttempted === true,
      evidence: result.x402,
    },
    {
      item: "payment_response_present",
      ok: Boolean(result.paymentResponseHeader),
      evidence: result.paymentResponseHeader,
    },
    {
      item: "payment_receipt_present",
      ok: Boolean(result.paymentReceiptHeader) || Boolean(result.receiptId),
      evidence: result.paymentReceiptHeader ?? result.receiptId,
    },
    {
      item: "payment_response_matches_paid_challenge",
      ok: !paymentChallengeId || !paymentResponseId || String(paymentChallengeId) === String(paymentResponseId),
      evidence: {
        paidChallengeId: paymentChallengeId,
        paymentResponseId,
      },
    },
    {
      item: "invocation_id_present",
      ok: Boolean(result.invocationId),
      evidence: result.invocationId,
    },
    {
      item: "receipt_id_present",
      ok: Boolean(result.receiptId),
      evidence: result.receiptId,
    },
    {
      item: "receipt_fetched_when_available",
      ok: result.receiptId ? Boolean(result.receipt) : true,
      evidence: result.receipt ? { receiptId: result.receipt.id ?? result.receipt.receipt_id ?? result.receiptId } : null,
    },
    {
      item: "proof_state_honestly_classified",
      ok: proofClass === "missing" || proofClass === "submitted" || proofClass === "terminal" || proofClass.startsWith("other:"),
      evidence: { classification: proofClass, proof: result.proof },
    },
  ];
}

export class KeryxAgoragenticX402Client {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    this.executePath = options.executePath || EXECUTE_PATH;
    this.receiptPath = options.receiptPath || RECEIPT_PATH;
    this.proofPath = options.proofPath || PROOF_PATH;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.pay = options.pay;
    this.apiKey = options.apiKey || process.env.AGORAGENTIC_API_KEY || "";
    this.maxNetworkRetries = options.maxNetworkRetries ?? 1;
    this.receiptFetchEnabled = options.receiptFetchEnabled ?? true;
    this.proofFetchEnabled = options.proofFetchEnabled ?? true;
    this.proofPolls = options.proofPolls ?? 1;
    this.proofPollDelayMs = options.proofPollDelayMs ?? 100;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("fetchImpl is required (Node 18+ or pass fetchImpl)");
    }
  }

  buildAuthHeaders(extra = {}) {
    const headers = {
      accept: "application/json",
      ...lowerCaseHeaders(extra),
    };
    if (this.apiKey && !headers.authorization) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async execute(request = {}) {
    const x402Fetch = await loadX402Fetch();
    const idempotencyKey = request.idempotencyKey || randomUUID();
    const body = {
      task: request.task || "keryx.execute",
      input: request.input || {},
      metadata: {
        client: "tang-vu/keryx",
        ...(request.metadata || {}),
      },
    };
    if (request.quoteId) body.quote_id = request.quoteId;
    if (request.constraints) body.constraints = request.constraints;

    let response;
    try {
      response = await x402Fetch(buildUrl(this.baseUrl, this.executePath), {
        fetchImpl: request.fetchImpl || this.fetchImpl,
        pay: request.pay || this.pay,
        idempotencyKey,
        maxNetworkRetries: request.maxNetworkRetries ?? this.maxNetworkRetries,
        method: "POST",
        headers: {
          ...this.buildAuthHeaders(request.headers),
          "content-type": "application/json",
        },
        body,
      });
    } catch (error) {
      throw createExecuteError(`keryx execute failed before HTTP success: ${error.message}`, {
        classified: classifyThrownError(error),
        cause: error,
        idempotencyKey,
      });
    }

    const executePayload = await safeJson(response);
    const invocationId = extractInvocationId(executePayload);
    const receiptId = extractReceiptId(executePayload, response);
    const paymentResponseHeader = readHeader(response, "payment-response");
    const paymentReceiptHeader = readHeader(response, "payment-receipt");
    const paymentResponse = decodeStructuredValue(paymentResponseHeader) ?? executePayload?.payment ?? null;
    const paidChallenge = response?.x402Meta?.challenge ?? null;

    if (!response.ok) {
      throw createExecuteError(`keryx execute returned HTTP ${response.status}`, {
        status: response.status,
        payload: executePayload,
        classified: "http_error",
        idempotencyKey,
        invocationId,
        receiptId,
      });
    }

    let receipt = null;
    if (this.receiptFetchEnabled && receiptId) {
      receipt = await this.fetchReceipt(receiptId, request.receiptHeaders);
    }

    let proof = null;
    if (this.proofFetchEnabled && invocationId) {
      proof = await this.fetchProof(invocationId, request.proofHeaders);
    }

    const result = {
      ok: true,
      idempotencyKey,
      invocationId,
      receiptId,
      responseStatus: response.status,
      output: executePayload?.output ?? executePayload?.result ?? null,
      execute: executePayload,
      receipt,
      proof,
      paymentResponse,
      paymentResponseHeader,
      paymentReceiptHeader,
      paidChallenge,
      x402: response.x402Meta ?? null,
    };
    result.checklist = buildChecklist(result);
    return result;
  }

  async fetchReceipt(receiptId, extraHeaders = {}) {
    return ensureOkJson(this.fetchImpl, buildUrl(this.baseUrl, this.receiptPath(receiptId)), {
      method: "GET",
      headers: this.buildAuthHeaders(extraHeaders),
    }, `receipt(${receiptId})`);
  }

  async fetchProof(invocationId, extraHeaders = {}) {
    const url = buildUrl(this.baseUrl, this.proofPath(invocationId));
    let lastProof = null;
    for (let attempt = 1; attempt <= this.proofPolls; attempt += 1) {
      lastProof = await ensureOkJson(this.fetchImpl, url, {
        method: "GET",
        headers: this.buildAuthHeaders(extraHeaders),
      }, `proof(${invocationId})`);
      if (classifyProof(lastProof) !== "submitted" || attempt === this.proofPolls) {
        return lastProof;
      }
      await delay(this.proofPollDelayMs);
    }
    return lastProof;
  }
}

export async function createKeryxExecuteAdapter(options = {}) {
  return new KeryxAgoragenticX402Client(options);
}

export async function demoKeryxExecuteBuyerRetry() {
  const paymentRequired = [{
    scheme: "exact",
    network: "base",
    asset: "USDC",
    amount: "25000",
    pay_to: "0xFAC1L17A70R0000000000000000000000000000",
    challenge_id: "chall_demo_123",
    resource: "/api/x402/execute",
  }];

  const paymentRequiredHeader = Buffer.from(JSON.stringify(paymentRequired), "utf8").toString("base64");
  const paymentResponseValue = {
    payment_id: "chall_demo_123",
    authorization_type: "mock-signature",
    network: "base",
  };
  const paymentResponseHeader = Buffer.from(JSON.stringify(paymentResponseValue), "utf8").toString("base64");

  const state = {
    executeCalls: 0,
    payCalls: 0,
    idempotencyKeys: [],
    paymentSignatures: [],
    paymentReceiptHeader: "rcpt_demo_123",
  };

  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method || "GET").toUpperCase();
    const headers = lowerCaseHeaders(init.headers || {});
    const pathname = new URL(url).pathname;

    if (method === "POST" && pathname === EXECUTE_PATH) {
      state.executeCalls += 1;
      state.idempotencyKeys.push(headers["idempotency-key"] || null);
      state.paymentSignatures.push(headers["payment-signature"] || null);

      if (state.executeCalls === 1) {
        return new Response(JSON.stringify({
          error: "payment required",
          code: "payment_required",
        }), {
          status: 402,
          headers: {
            "content-type": "application/json",
            "payment-required": paymentRequiredHeader,
          },
        });
      }

      if (state.executeCalls === 2) {
        throw createExecuteError("simulated transient network drop", { name: "NetworkError" });
      }

      return new Response(JSON.stringify({
        ok: true,
        invocation_id: "inv_demo_123",
        receipt_id: state.paymentReceiptHeader,
        result: {
          provider: "demo-seller",
          summary: "keryx execute completed",
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "payment-response": paymentResponseHeader,
          "payment-receipt": state.paymentReceiptHeader,
        },
      });
    }

    if (method === "GET" && pathname === RECEIPT_PATH(state.paymentReceiptHeader)) {
      return new Response(JSON.stringify({
        id: state.paymentReceiptHeader,
        payment: {
          payment_id: "chall_demo_123",
        },
        challenge: {
          challenge_id: "chall_demo_123",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (method === "GET" && pathname === PROOF_PATH("inv_demo_123")) {
      return new Response(JSON.stringify({
        invocation_id: "inv_demo_123",
        status: "submitted",
        transaction_hash: "0xdemo",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: `unexpected ${method} ${pathname}` }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };

  const pay = async (paymentRequiredRaw, context) => {
    state.payCalls += 1;
    assert.equal(context.idempotencyKey, state.idempotencyKeys[0]);
    const challenges = parsePaymentRequired(paymentRequiredRaw);
    assert.equal(challenges.length, 1);
    assert.equal(extractChallengeId(challenges[0]), "chall_demo_123");
    return {
      paymentSignature: "mock-signature-1",
      authorizationHeader: "X402 mock-signature-1",
      paymentId: "chall_demo_123",
    };
  };

  const client = new KeryxAgoragenticX402Client({
    baseUrl: DEFAULT_BASE_URL,
    fetchImpl,
    pay,
    proofPolls: 1,
  });

  const result = await client.execute({
    task: "summarize repository diff",
    input: {
      repo: "tang-vu/keryx",
      prompt: "Summarize changed files and highlight risky areas.",
    },
    constraints: {
      max_cost: 0.25,
    },
    metadata: {
      workflow: "demo",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.responseStatus, 200);
  assert.equal(result.invocationId, "inv_demo_123");
  assert.equal(result.receiptId, state.paymentReceiptHeader);
  assert.equal(result.paymentResponse?.payment_id, "chall_demo_123");
  assert.equal(result.receipt?.challenge?.challenge_id, "chall_demo_123");
  assert.equal(classifyProof(result.proof), "submitted");
  assert.equal(state.payCalls, 1, "pay() must only run once after the first 402");
  assert.equal(state.executeCalls, 3, "execute() should retry after one network drop");
  assert.equal(new Set(state.idempotencyKeys).size, 1, "same idempotency key must be reused across retries");
  assert.deepEqual(state.paymentSignatures, [null, "mock-signature-1", "mock-signature-1"]);
  assert.equal(result.checklist.every((item) => item.ok), true);

  return {
    ok: true,
    idempotencyKey: result.idempotencyKey,
    invocationId: result.invocationId,
    receiptId: result.receiptId,
    proofClassification: classifyProof(result.proof),
    paymentAuthorizedOnce: state.payCalls === 1,
    checklist: result.checklist,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  demoKeryxExecuteBuyerRetry()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error?.stack || String(error));
      process.exitCode = 1;
    });
}
