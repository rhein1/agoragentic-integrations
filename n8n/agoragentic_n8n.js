/**
 * Agoragentic x n8n
 * =================
 *
 * Honest scope:
 * - n8n runs the automation.
 * - Agoragentic handles routing, payment, and receipts.
 * - These helpers are intended for Code node + HTTP Request node combinations.
 */

const DEFAULT_BASE_URL = "https://agoragentic.com";
const DEFAULT_X402_EDGE_URL = "https://x402.agoragentic.com";

function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const qs = query.toString();
  return qs ? `?${qs}` : "";
}

function buildMatchRequest({
  baseUrl = DEFAULT_BASE_URL,
  apiKey,
  task,
  constraints = {},
}) {
  return {
    method: "GET",
    url: `${baseUrl}/api/execute/match${buildQuery({ task, ...constraints })}`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };
}

function buildExecuteRequest({
  baseUrl = DEFAULT_BASE_URL,
  apiKey,
  task,
  input = {},
  constraints = {},
}) {
  return {
    method: "POST",
    url: `${baseUrl}/api/execute`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: {
      task,
      input,
      constraints,
    },
  };
}

function buildX402ServiceRequest({
  edgeUrl = DEFAULT_X402_EDGE_URL,
  slug,
  payload = {},
  paymentSignature,
}) {
  if (!slug) {
    throw new Error("slug is required for stable x402 edge requests");
  }

  const headers = {
    "Content-Type": "application/json",
  };

  if (paymentSignature) {
    headers["PAYMENT-SIGNATURE"] = paymentSignature;
  }

  return {
    method: "POST",
    url: `${edgeUrl}/v1/${encodeURIComponent(String(slug))}`,
    headers,
    body: payload,
  };
}

function buildX402ReceiptRequest({
  edgeUrl = DEFAULT_X402_EDGE_URL,
  receiptId,
}) {
  if (!receiptId) {
    throw new Error("receiptId is required for x402 edge receipt lookup");
  }

  return {
    method: "GET",
    url: `${edgeUrl}/v1/receipts/${encodeURIComponent(String(receiptId))}`,
    headers: {},
  };
}

function extractMarketplaceReceipt(payload) {
  return {
    invocationId: payload.invocation_id || null,
    receiptId: payload.receipt_id || payload.receipt?.id || null,
    status: payload.status || payload.receipt?.status || null,
    output: payload.output || payload.result || payload.response || null,
  };
}

function extractX402Outcome(payload, headers = {}) {
  return {
    receiptId: headers["payment-receipt"] || headers["Payment-Receipt"] || payload?.receipt_id || null,
    paymentResponse: headers["payment-response"] || headers["PAYMENT-RESPONSE"] || null,
    status: payload?.status || null,
    output: payload?.output || payload?.result || payload?.response || payload || null,
  };
}

module.exports = {
  buildMatchRequest,
  buildExecuteRequest,
  extractMarketplaceReceipt,
};
