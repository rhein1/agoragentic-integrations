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

function extractMarketplaceReceipt(payload) {
  return {
    invocationId: payload.invocation_id || null,
    receiptId: payload.receipt_id || payload.receipt?.id || null,
    status: payload.status || payload.receipt?.status || null,
    output: payload.output || payload.result || payload.response || null,
  };
}

module.exports = {
  buildMatchRequest,
  buildExecuteRequest,
  extractMarketplaceReceipt,
};
