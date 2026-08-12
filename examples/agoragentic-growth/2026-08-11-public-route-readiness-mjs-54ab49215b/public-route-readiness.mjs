import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const DISCOVERY_FAILURES = new Set([
  "discovery_unavailable",
  "discovery_timeout",
  "discovery_not_found",
  "discovery_malformed",
]);

const BUYER_FAILURES = new Set([
  "cancelled",
  "error",
  "failed",
  "failure",
  "network_error",
  "timeout",
  "unavailable",
]);

const BUYER_SUCCESS = new Set(["completed", "ok", "succeeded", "success"]);
const BUYER_UNCHECKED = new Set(["not_checked", "not_run", "pending", "unchecked"]);

const SECRET_KEY = /(?:key|token|secret|password|cookie|credential|signature)/i;

function cleanText(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(?:amk|sk|pk)_[A-Za-z0-9._~-]+/gi, "[redacted]")
    .replace(/[A-Za-z0-9+/]{32,}={0,2}/g, "[redacted]")
    .slice(0, 240);
}

function safeDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    if (typeof item === "string") output[key] = cleanText(item);
    else if (typeof item === "number" || typeof item === "boolean") {
      output[key] = item;
    }
  }
  return output;
}

function normalizeEvent(event = {}) {
  return {
    surface: event.surface === "buyer" || event.surface === "discovery"
      ? event.surface
      : "unknown",
    state: cleanText(event.state || event.code || "unknown").toLowerCase(),
    status: Number.isInteger(event.status) ? event.status : null,
    details: safeDetails(event.details),
  };
}

function latestEvent(items, surface) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].surface === surface) return items[index];
  }
  return undefined;
}

function discoveryAvailable(event) {
  const item = normalizeEvent(event);
  if (item.surface !== "discovery") return false;
  if (item.status !== null && item.status >= 500) return false;
  if (DISCOVERY_FAILURES.has(item.state)) return false;
  return item.state === "available" || item.status === 200;
}

function buyerSucceeded(event) {
  const item = normalizeEvent(event);
  if (item.surface !== "buyer" || BUYER_FAILURES.has(item.state)) return false;
  if (item.status !== null) return item.status >= 200 && item.status < 300;
  return BUYER_SUCCESS.has(item.state);
}

function diagnose(events) {
  const items = Array.isArray(events) ? events.map(normalizeEvent) : [];
  const discovery = latestEvent(items, "discovery");
  const buyer = latestEvent(items, "buyer");

  if (!discovery) {
    return {
      category: "discovery_unavailable",
      ready: false,
      message: "Public discovery was not observed. Check the published route, DNS, and edge availability, then retry discovery before debugging the buyer request.",
      evidence: { discovery: "missing", buyer: buyer ? buyer.state : "missing" },
    };
  }

  if (!discoveryAvailable(discovery)) {
    return {
      category: "discovery_unavailable",
      ready: false,
      message: "Public discovery is unavailable. Verify the route is published, reachable without private headers, and returning a usable response.",
      evidence: {
        discovery: discovery.state,
        status: discovery.status,
        buyer: buyer ? buyer.state : "not_checked",
      },
    };
  }

  if (!buyer) {
    return {
      category: "discovery_ready_buyer_unchecked",
      ready: false,
      message: "Public discovery is available. Run the buyer request with the documented path and inspect only its status and safe error text.",
      evidence: { discovery: "available", buyer: "missing" },
    };
  }

  if (BUYER_UNCHECKED.has(buyer.state)) {
    return {
      category: "discovery_ready_buyer_unchecked",
      ready: false,
      message: "Public discovery is available, but the buyer request has not completed. Run the documented buyer request before claiming end-to-end readiness.",
      evidence: { discovery: "available", buyer: buyer.state },
    };
  }

  if (!buyerSucceeded(buyer)) {
    return {
      category: "buyer_flow_failure",
      ready: false,
      message: "Public discovery is available, so the failure is in the buyer request path. Check the URL path, method, input shape, and client-side error handling.",
      evidence: {
        discovery: "available",
        buyer: buyer.state,
        status: buyer.status,
      },
    };
  }

  return {
    category: "ready",
    ready: true,
    message: "Public discovery and the buyer request completed. Continue with normal application-level verification.",
    evidence: { discovery: "available", buyer: buyer.state },
  };
}

export function publicRouteReadiness(events) {
  return diagnose(events);
}

export function remediationFor(events) {
  const result = diagnose(events);
  return {
    category: result.category,
    ready: result.ready,
    message: result.message,
    evidence: result.evidence,
  };
}

function testRedaction() {
  const result = publicRouteReadiness([
    {
      surface: "discovery",
      state: "available",
      status: 200,
      details: {
        note: "Bearer very-long-value-that-must-not-appear",
        apiKey: "amk_do-not-print-this",
        region: "test",
      },
    },
    {
      surface: "buyer",
      state: "failed",
      status: 404,
    },
  ]);

  assert.equal(result.category, "buyer_flow_failure");
  assert.equal(result.ready, false);
  assert.equal(result.evidence.discovery, "available");
  assert.equal(result.evidence.buyer, "failed");
  assert(!JSON.stringify(result).includes("do-not-print"));
  assert(!JSON.stringify(result).includes("very-long-value"));
}

function testUnavailableDiscovery() {
  const result = publicRouteReadiness([
    { surface: "discovery", state: "discovery_timeout", status: 504 },
    { surface: "buyer", state: "not_run" },
  ]);

  assert.equal(result.category, "discovery_unavailable");
  assert.match(result.message, /published|reachable|response/i);
  assert.equal(result.evidence.discovery, "discovery_timeout");
}

function testMissingDiscovery() {
  const result = publicRouteReadiness([
    { surface: "buyer", state: "failed", status: 400 },
  ]);

  assert.equal(result.category, "discovery_unavailable");
  assert.match(result.message, /discovery/i);
  assert.equal(result.evidence.discovery, "missing");
}

function testReadyWithoutBuyer() {
  const result = remediationFor([
    { surface: "discovery", state: "available", status: 200 },
  ]);

  assert.equal(result.category, "discovery_ready_buyer_unchecked");
  assert.equal(result.ready, false);
  assert.match(result.message, /buyer request/i);
}

function testSuccessfulRun() {
  const result = publicRouteReadiness([
    { surface: "discovery", state: "available", status: 200 },
    { surface: "buyer", state: "completed", status: 200 },
  ]);

  assert.equal(result.category, "ready");
  assert.equal(result.ready, true);
}

function testBuyerFailureStatesFailClosed() {
  for (const state of ["timeout", "network_error", "unavailable"]) {
    const result = publicRouteReadiness([
      { surface: "discovery", state: "available", status: 200 },
      { surface: "buyer", state },
    ]);
    assert.equal(result.category, "buyer_flow_failure");
    assert.equal(result.ready, false);
  }
}

function testUncheckedBuyerDoesNotClaimCompletion() {
  const result = publicRouteReadiness([
    { surface: "discovery", state: "available", status: 200 },
    { surface: "buyer", state: "not_run" },
  ]);

  assert.equal(result.category, "discovery_ready_buyer_unchecked");
  assert.equal(result.ready, false);
  assert.match(result.message, /has not completed/i);
}

function testUnknownBuyerFailsClosed() {
  const result = publicRouteReadiness([
    { surface: "discovery", state: "available", status: 200 },
    { surface: "buyer", state: "unknown" },
  ]);

  assert.equal(result.category, "buyer_flow_failure");
  assert.equal(result.ready, false);
}

function testUnknownSurfaceCannotBecomeDiscovery() {
  const result = publicRouteReadiness([
    { surface: "discoveri", state: "available", status: 200 },
    { surface: "buyer", state: "completed", status: 200 },
  ]);

  assert.equal(result.category, "discovery_unavailable");
  assert.equal(result.ready, false);
}

function testLatestSurfaceEventWins() {
  const result = publicRouteReadiness([
    { surface: "discovery", state: "available", status: 200 },
    { surface: "discovery", state: "discovery_timeout", status: 504 },
    { surface: "buyer", state: "completed", status: 200 },
  ]);

  assert.equal(result.category, "discovery_unavailable");
  assert.equal(result.ready, false);
  assert.equal(result.evidence.discovery, "discovery_timeout");
}

function runSelfTest() {
  testRedaction();
  testUnavailableDiscovery();
  testMissingDiscovery();
  testReadyWithoutBuyer();
  testSuccessfulRun();
  testBuyerFailureStatesFailClosed();
  testUncheckedBuyerDoesNotClaimCompletion();
  testUnknownBuyerFailsClosed();
  testUnknownSurfaceCannotBecomeDiscovery();
  testLatestSurfaceEventWins();
  console.log("public-route-readiness self-test passed");
  console.log("AGOS_RUNTIME_OK");
}

const entrypoint = fileURLToPath(import.meta.url);
if (process.argv[1] && fileURLToPath(new URL(`file://${process.argv[1]}`)) === entrypoint) {
  runSelfTest();
}
