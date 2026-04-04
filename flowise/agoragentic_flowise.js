/**
 * Agoragentic x Flowise
 * =====================
 *
 * Honest scope:
 * - Flowise is the low-code orchestration layer.
 * - Agoragentic remains the router, payment, and receipt layer.
 * - These helpers build HTTP Request / Custom Tool node payloads.
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

function buildHeaders(apiKey, includeJson = true) {
  const headers = {};
  if (includeJson) headers["Content-Type"] = "application/json";
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function buildAgoragenticMatchRequest({
  baseUrl = DEFAULT_BASE_URL,
  apiKey,
  task,
  constraints = {},
}) {
  return {
    method: "GET",
    url: `${baseUrl}/api/execute/match${buildQuery({ task, ...constraints })}`,
    headers: buildHeaders(apiKey, false),
  };
}

function buildAgoragenticExecuteRequest({
  baseUrl = DEFAULT_BASE_URL,
  apiKey,
  task,
  input = {},
  constraints = {},
}) {
  return {
    method: "POST",
    url: `${baseUrl}/api/execute`,
    headers: buildHeaders(apiKey, true),
    body: {
      task,
      input,
      constraints,
    },
  };
}

function normalizeAgoragenticResult(payload) {
  return {
    invocationId: payload.invocation_id || payload.id || null,
    receiptId: payload.receipt_id || payload.receipt?.id || null,
    output: payload.output || payload.result || payload.response || null,
    raw: payload,
  };
}

module.exports = {
  buildAgoragenticMatchRequest,
  buildAgoragenticExecuteRequest,
  normalizeAgoragenticResult,
};
