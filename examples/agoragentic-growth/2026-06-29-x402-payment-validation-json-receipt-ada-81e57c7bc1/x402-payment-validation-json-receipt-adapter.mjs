#!/usr/bin/env node
// demo — self-test moves no real funds; payment authorization below is mocked.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = process.env.AGORAGENTIC_URL || "https://agoragentic.com";
const DEFAULT_RECEIPT_PATH = "/api/commerce/receipts/{receipt_id}";

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

      return x402FetchWithFallback;
    })();
  }
  return cachedX402FetchPromise;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    return headers.get(name) ?? headers.get(String(name).toLowerCase()) ?? null;
  }
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return null;
}

function readAnyHeader(headers, ...names) {
  for (const name of names) {
    const value = readHeader(headers, name);
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function decodeStructuredValue(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const attempts = [raw.trim()];
  try {
    attempts.push(Buffer.from(raw.trim(), "base64").toString("utf8"));
  } catch {}

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return raw;
}

function extractReceiptId(value) {
  if (value === null || value === undefined || value === "") return null;
  const structured = typeof value === "string" ? decodeStructuredValue(value) : value;
  if (typeof structured === "string") return structured.trim() || null;
  return getPath(structured,
    ["receipt_id"],
    ["receiptId"],
    ["payment_receipt_id"],
    ["id"],
    ["receipt", "receipt_id"],
    ["receipt", "receiptId"],
    ["receipt", "id"],
    ["settlement", "receipt_id"],
    ["settlement", "receiptId"],
    ["settlement", "id"]
  );
}

function normalizeSettlementStatus(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") {
    return getPath(value, ["status"], ["settlement_status"], ["state"]) ?? null;
  }
  return String(value);
}

function getPath(source, ...paths) {
  for (const path of paths) {
    let current = source;
    let ok = true;
    for (const segment of path) {
      if (current && typeof current === "object" && segment in current) {
        current = current[segment];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && current !== undefined && current !== null && current !== "") {
      return current;
    }
  }
  return null;
}

function normalizeAmountValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number(value.toFixed(6)).toString();
  }
  const text = String(value).trim();
  if (!text) return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return text;
  }
  return null;
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    return normalizeTimestamp(Number(text));
  }
  const time = Date.parse(text);
  return Number.isNaN(time) ? text : new Date(time).toISOString();
}

function normalizeTransactionId(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  return text || null;
}

function joinUrl(baseUrl, path) {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

async function x402FetchWithFallback(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    pay,
    idempotencyKey = randomUUID(),
    method = "POST",
    headers = {},
    body,
    signal,
  } = options;

  const firstHeaders = {
    ...headers,
    "Idempotency-Key": idempotencyKey,
  };
  const first = await fetchImpl(url, {
    method,
    headers: firstHeaders,
    body: body === undefined || typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });

  if (first.status !== 402) return first;

  const challengeHeader = readAnyHeader(first.headers, "payment-required", "x-payment-required", "PAYMENT-REQUIRED");
  if (!challengeHeader) {
    throw new Error("Received HTTP 402 without payment-required header");
  }
  if (typeof pay !== "function") {
    throw new Error("pay callback is required after x402 payment challenge");
  }

  const payment = await pay(challengeHeader, { idempotencyKey, response: first });
  const signature = typeof payment === "string"
    ? payment
    : payment?.paymentSignature ?? payment?.payment_signature ?? payment?.signature ?? payment?.authorization;

  if (!signature) {
    throw new Error("pay callback did not return a payment signature");
  }

  const paid = await fetchImpl(url, {
    method,
    headers: {
      ...headers,
      "Idempotency-Key": idempotencyKey,
      "Payment-Signature": signature,
    },
    body: body === undefined || typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });
  if (paid.status === 402) {
    throw new Error("Paid request received another HTTP 402 challenge; refusing to re-authorize payment");
  }
  return paid;
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildReceiptLookupUrl(baseUrl, receiptId, receiptPathTemplate = DEFAULT_RECEIPT_PATH) {
  const renderedPath = receiptPathTemplate.replace("{receipt_id}", encodeURIComponent(receiptId));
  return joinUrl(baseUrl, renderedPath.replace(/^\//, ""));
}

function normalizeAmount(receiptSource, fallbackPayload, challenge) {
  const raw = normalizeAmountValue(
    getPath(receiptSource,
      ["receipt", "amount"],
      ["receipt", "amount_usdc"],
      ["receipt", "cost_usdc"],
      ["receipt", "price_usdc"],
      ["receipt", "max_amount_usdc"],
      ["amount"],
      ["amount_usdc"],
      ["settlement", "amount"],
      ["settlement", "amount_usdc"],
      ["settlement", "cost_usdc"],
      ["payment", "amount"],
      ["payment", "amount_usdc"],
      ["pricing", "amount"],
      ["pricing", "amount_usdc"],
      ["pricing", "price_usdc"],
      ["pricing", "max_amount_usdc"],
      ["cost_usdc"],
      ["price_usdc"],
      ["max_amount_usdc"],
      ["cost"]
    )
    ?? getPath(fallbackPayload,
      ["receipt", "amount"],
      ["receipt", "amount_usdc"],
      ["receipt", "cost_usdc"],
      ["receipt", "price_usdc"],
      ["receipt", "max_amount_usdc"],
      ["amount"],
      ["amount_usdc"],
      ["settlement", "amount"],
      ["settlement", "amount_usdc"],
      ["settlement", "cost_usdc"],
      ["payment", "amount"],
      ["payment", "amount_usdc"],
      ["pricing", "amount"],
      ["pricing", "amount_usdc"],
      ["pricing", "price_usdc"],
      ["pricing", "max_amount_usdc"],
      ["cost_usdc"],
      ["price_usdc"],
      ["max_amount_usdc"],
      ["cost"]
    )
    ?? getPath(challenge,
      ["amount"],
      ["amount_usdc"],
      ["maxAmountRequired"],
      ["max_amount_usdc"],
      ["max_cost"],
      ["maxCost"],
      ["max_price_usdc"],
      ["value"]
    )
  );

  const currency = getPath(receiptSource,
    ["receipt", "currency"],
    ["currency"],
    ["settlement", "currency"],
    ["payment", "currency"]
  ) ?? getPath(fallbackPayload,
    ["receipt", "currency"],
    ["currency"],
    ["settlement", "currency"],
    ["payment", "currency"]
  ) ?? getPath(challenge,
    ["asset"],
    ["currency"],
    ["token"]
  ) ?? "USDC";

  const decimals = getPath(receiptSource,
    ["receipt", "decimals"],
    ["decimals"],
    ["settlement", "decimals"]
  ) ?? getPath(fallbackPayload,
    ["receipt", "decimals"],
    ["decimals"],
    ["settlement", "decimals"]
  ) ?? getPath(challenge,
    ["assetDecimals"],
    ["decimals"]
  ) ?? null;

  return {
    raw,
    currency: String(currency),
    decimals: decimals === null || decimals === undefined || decimals === "" ? null : Number(decimals),
  };
}

function normalizeStructuredReceipt({
  receiptId,
  invocationId,
  idempotencyKey,
  responsePayload,
  receiptPayload,
  paymentResponse,
  paymentReceiptHeader,
  challenge,
  requestUrl,
}) {
  const source = receiptPayload ?? responsePayload ?? paymentResponse ?? {};
  const amount = normalizeAmount(source, responsePayload, challenge);
  const transactionId = normalizeTransactionId(
    getPath(source,
      ["receipt", "txHash"],
      ["receipt", "tx_hash"],
      ["txHash"],
      ["tx_hash"],
      ["transaction_hash"],
      ["transaction_id"],
      ["transactionId"],
      ["payment", "txHash"],
      ["payment", "tx_hash"],
      ["payment", "transaction_hash"],
      ["payment", "transactionId"],
      ["settlement", "txHash"],
      ["settlement", "tx_hash"],
      ["settlement", "transaction_hash"],
      ["settlement", "transactionId"],
      ["proof", "txHash"],
      ["proof", "tx_hash"],
      ["proof", "transaction_hash"]
    )
    ?? getPath(responsePayload,
      ["receipt", "txHash"],
      ["receipt", "tx_hash"],
      ["txHash"],
      ["tx_hash"],
      ["transaction_hash"],
      ["transaction_id"],
      ["transactionId"],
      ["payment", "txHash"],
      ["payment", "tx_hash"],
      ["payment", "transaction_hash"],
      ["payment", "transactionId"],
      ["settlement", "txHash"],
      ["settlement", "tx_hash"],
      ["settlement", "transaction_hash"],
      ["settlement", "transactionId"]
    )
    ?? getPath(paymentResponse,
      ["txHash"],
      ["tx_hash"],
      ["transaction_hash"],
      ["transaction_id"],
      ["transactionId"]
    )
  );

  const timestamp = normalizeTimestamp(
    getPath(source,
      ["receipt", "timestamp"],
      ["timestamp"],
      ["paid_at"],
      ["created_at"],
      ["settlement", "timestamp"],
      ["payment", "timestamp"]
    )
    ?? getPath(responsePayload,
      ["receipt", "timestamp"],
      ["timestamp"],
      ["paid_at"],
      ["created_at"],
      ["settlement", "timestamp"],
      ["payment", "timestamp"]
    )
    ?? getPath(paymentResponse,
      ["timestamp"],
      ["paid_at"]
    )
  );

  return {
    receipt_id: receiptId,
    invocation_id: invocationId,
    timestamp,
    amount,
    transaction_id: transactionId,
    settlement_status: normalizeSettlementStatus(getPath(source,
      ["receipt", "settlement"],
      ["receipt", "settlement_status"],
      ["settlement"],
      ["settlement_status"],
      ["status"],
      ["payment", "status"]
    ) ?? getPath(responsePayload,
      ["receipt", "settlement"],
      ["receipt", "settlement_status"],
      ["settlement"],
      ["settlement_status"],
      ["status"]
    )),
    payer: getPath(source, ["receipt", "from"], ["from"], ["payer"], ["settlement", "payer"]) ?? null,
    payee: getPath(source, ["receipt", "to"], ["to"], ["payee"], ["settlement", "payee"]) ?? null,
    chain: getPath(source, ["receipt", "chain"], ["chain"], ["settlement", "chain"]) ?? null,
    chain_id: getPath(source, ["receipt", "chainId"], ["chainId"], ["chain_id"], ["settlement", "chainId"]) ?? null,
    payment_receipt_header: paymentReceiptHeader ?? null,
    idempotency_key: idempotencyKey,
    request_url: requestUrl,
    raw_receipt: receiptPayload,
    raw_response: responsePayload,
    raw_payment_response: paymentResponse,
  };
}

async function fetchReceiptJson(receiptId, options) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    receiptPathTemplate = DEFAULT_RECEIPT_PATH,
    headers = {},
  } = options;

  if (!receiptId) return null;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required to load receipt JSON");
  }

  const receiptUrl = buildReceiptLookupUrl(baseUrl, receiptId, receiptPathTemplate);
  const response = await fetchImpl(receiptUrl, {
    method: "GET",
    headers: {
      accept: "application/json",
      ...headers,
    },
  });

  if (!response.ok) {
    const body = await safeJson(response);
    const error = new Error(`Receipt lookup failed with HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    error.receiptUrl = receiptUrl;
    throw error;
  }

  return await safeJson(response);
}

export async function validateX402Payment(url, options = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    pay,
    idempotencyKey = randomUUID(),
    method = "POST",
    headers = {},
    body,
    signal,
    receiptPathTemplate = DEFAULT_RECEIPT_PATH,
    receiptHeaders = {},
    fetchReceipt = true,
    maxNetworkRetries = 1,
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required");
  }
  if (typeof pay !== "function") {
    throw new Error("pay callback is required");
  }

  const x402Fetch = await loadX402Fetch();
  const response = await x402Fetch(url, {
    fetchImpl,
    pay,
    idempotencyKey,
    method,
    headers,
    body,
    signal,
    maxNetworkRetries,
  });

  const paymentRequiredHeader = readAnyHeader(response.headers, "payment-required", "x-payment-required", "PAYMENT-REQUIRED");
  const paymentReceiptHeader = readAnyHeader(response.headers, "payment-receipt", "x-payment-receipt", "PAYMENT-RECEIPT");
  const paymentResponseHeader = readAnyHeader(response.headers, "payment-response", "x-payment-response", "PAYMENT-RESPONSE");
  const responsePayload = await safeJson(response);

  if (!response.ok) {
    const error = new Error(`x402 request failed with HTTP ${response.status}`);
    error.status = response.status;
    error.body = responsePayload;
    throw error;
  }

  const paymentResponse = asObject(decodeStructuredValue(paymentResponseHeader));
  const responseObject = asObject(responsePayload);
  const challenge = (() => {
    const decoded = decodeStructuredValue(paymentRequiredHeader);
    if (Array.isArray(decoded)) return asObject(decoded[0]);
    if (asObject(decoded)?.challenges && Array.isArray(decoded.challenges)) {
      return asObject(decoded.challenges[0]);
    }
    return asObject(decoded);
  })();

  const receiptId = getPath(responseObject,
    ["receipt_id"],
    ["receiptId"],
    ["payment_receipt_id"],
    ["receipt", "receipt_id"],
    ["receipt", "receiptId"],
    ["receipt", "id"],
    ["settlement", "receipt_id"],
    ["settlement", "receiptId"],
    ["settlement", "id"]
  ) ?? extractReceiptId(paymentReceiptHeader);

  const invocationId = getPath(responseObject,
    ["invocation_id"],
    ["invocationId"],
    ["result", "invocation_id"]
  ) ?? null;

  const receiptPayload = fetchReceipt && receiptId
    ? await fetchReceiptJson(receiptId, {
        baseUrl,
        fetchImpl,
        receiptPathTemplate,
        headers: receiptHeaders,
      })
    : null;

  const structuredReceipt = normalizeStructuredReceipt({
    receiptId,
    invocationId,
    idempotencyKey,
    responsePayload: responseObject,
    receiptPayload: asObject(receiptPayload),
    paymentResponse,
    paymentReceiptHeader,
    challenge,
    requestUrl: url,
  });

  if (!structuredReceipt.receipt_id) {
    throw new Error("Unable to determine receipt_id from x402 response");
  }
  if (!structuredReceipt.timestamp) {
    throw new Error("Unable to determine receipt timestamp from x402 response or receipt registry");
  }
  if (!structuredReceipt.amount.raw) {
    throw new Error("Unable to determine paid amount from x402 response or receipt registry");
  }
  if (!structuredReceipt.transaction_id) {
    throw new Error("Unable to determine transaction_id from x402 response or receipt registry");
  }

  return structuredReceipt;
}

function createJsonResponse(status, body, headers = {}) {
  const normalizedHeaders = new Headers({ "content-type": "application/json", ...headers });
  return new Response(JSON.stringify(body), { status, headers: normalizedHeaders });
}

async function runSelfTest() {
  const executeUrl = "https://demo.agoragentic.test/api/x402/invoke/demo-listing";
  const receiptUrl = "https://demo.agoragentic.test/api/commerce/receipts/rcpt_demo_123";
  const paymentRequiredPayload = [{
    scheme: "exact",
    network: "base",
    asset: "USDC",
    maxAmountRequired: "0.25",
    payTo: "0xfeedface",
  }];
  const paymentRequiredHeader = Buffer.from(JSON.stringify(paymentRequiredPayload)).toString("base64");

  const captured = {
    payCalls: 0,
    executeCalls: [],
    receiptCalls: [],
  };

  const fetchImpl = async (url, init = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    if (url === executeUrl) {
      captured.executeCalls.push({ method: init.method, headers, body: init.body });
      if (!headers["payment-signature"]) {
        return new Response("", {
          status: 402,
          headers: new Headers({ "payment-required": paymentRequiredHeader }),
        });
      }
      return createJsonResponse(200, {
        invocation_id: "inv_demo_123",
        receipt_id: "rcpt_demo_123",
        status: "completed",
      }, {
        "payment-receipt": "rcpt_demo_123",
        "payment-response": Buffer.from(JSON.stringify({ transactionId: "0xabc123", timestamp: "2026-06-29T12:00:00Z" })).toString("base64"),
      });
    }

    if (url === receiptUrl) {
      captured.receiptCalls.push({ method: init.method, headers });
      return createJsonResponse(200, {
        receipt: {
          id: "rcpt_demo_123",
          amount: "0.25",
          currency: "USDC",
          chain: "base",
          chainId: 8453,
          from: "0x1111",
          to: "0x2222",
          txHash: "0xabc123",
          timestamp: "2026-06-29T12:00:00Z",
          settlement: "settled",
        },
      });
    }

    throw new Error(`Unexpected URL in self-test: ${url}`);
  };

  const receipt = await validateX402Payment(executeUrl, {
    baseUrl: "https://demo.agoragentic.test",
    fetchImpl,
    body: { prompt: "hello" },
    pay: async (paymentRequired, context) => {
      captured.payCalls += 1;
      assert.equal(paymentRequired, paymentRequiredHeader);
      assert.equal(context.idempotencyKey.length > 0, true);
      return {
        paymentSignature: "sig_demo_123",
      };
    },
    idempotencyKey: "idem-demo-123",
  });

  assert.equal(captured.payCalls, 1, "pay callback should be called once");
  assert.equal(captured.executeCalls.length, 2, "execute endpoint should be called twice");
  assert.equal(captured.executeCalls[0].headers["idempotency-key"], "idem-demo-123");
  assert.equal(captured.executeCalls[1].headers["idempotency-key"], "idem-demo-123");
  assert.equal(captured.executeCalls[1].headers["payment-signature"], "sig_demo_123");
  assert.equal(captured.receiptCalls.length, 1, "receipt endpoint should be called once");
  assert.equal(receipt.receipt_id, "rcpt_demo_123");
  assert.equal(receipt.invocation_id, "inv_demo_123");
  assert.equal(receipt.timestamp, "2026-06-29T12:00:00.000Z");
  assert.equal(receipt.amount.raw, "0.25");
  assert.equal(receipt.amount.currency, "USDC");
  assert.equal(receipt.transaction_id, "0xabc123");
  assert.equal(receipt.settlement_status, "settled");

  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const receipt = await runSelfTest();
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
