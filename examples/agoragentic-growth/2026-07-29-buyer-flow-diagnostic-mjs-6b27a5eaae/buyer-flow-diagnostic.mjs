import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const SURFACES = Object.freeze([
  "x402_info",
  "x402_services",
  "x402_manifest",
]);

const DEFAULT_OBSERVATIONS = Object.freeze([
  { surface: "x402_info", status: 503 },
  { surface: "x402_services", status: 503 },
  { surface: "x402_manifest", status: 503 },
]);

function classify(status) {
  if (status === 503) {
    return {
      category: "temporarily_unavailable",
      retry: true,
      guidance: "Retry with bounded exponential backoff after checking service health.",
    };
  }
  if (status >= 500 && status <= 599) {
    return {
      category: "upstream_failure",
      retry: true,
      guidance: "Retry cautiously after confirming the upstream failure is transient.",
    };
  }
  if (status >= 400 && status <= 499) {
    return {
      category: "request_or_route_failure",
      retry: false,
      guidance: "Do not retry unchanged; verify the route and request assumptions.",
    };
  }
  if (status >= 200 && status <= 299) {
    return {
      category: "available",
      retry: false,
      guidance: "No retry is indicated.",
    };
  }
  return {
    category: "unexpected_status",
    retry: false,
    guidance: "Capture the response and investigate before retrying.",
  };
}

function normalizeObservation(observation) {
  if (!observation || typeof observation !== "object") {
    throw new TypeError("observation must be an object");
  }
  const { surface, status } = observation;
  if (!SURFACES.includes(surface)) {
    throw new RangeError(`unknown surface: ${String(surface)}`);
  }
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new RangeError(`invalid status for ${surface}`);
  }
  return Object.freeze({ surface, status });
}

export function diagnose(observations) {
  if (!Array.isArray(observations)) {
    throw new TypeError("observations must be an array");
  }

  const normalized = observations.map(normalizeObservation);
  const bySurface = new Map(normalized.map((item) => [item.surface, item]));
  const results = SURFACES.map((surface) => {
    const observation = bySurface.get(surface);
    if (!observation) {
      return {
        surface,
        status: null,
        category: "not_observed",
        retry: false,
        guidance: "Collect one bounded observation before classifying this surface.",
      };
    }
    return { surface, status: observation.status, ...classify(observation.status) };
  });

  const unavailable = results.filter(
    (result) => result.category === "temporarily_unavailable",
  ).length;

  return Object.freeze({
    observed: normalized.length,
    unavailable,
    complete: results.every((result) => result.status !== null),
    results: Object.freeze(results),
    nextAction:
      unavailable === SURFACES.length
        ? "Check shared upstream health and capture timestamps for all three surfaces."
        : "Inspect each incomplete or failing surface independently.",
  });
}

export function formatReport(report) {
  if (!report || !Array.isArray(report.results)) {
    throw new TypeError("report must be a diagnostic result");
  }

  const lines = [
    "AGOS buyer-flow diagnostic",
    `observed=${report.observed} complete=${report.complete}`,
  ];
  for (const result of report.results) {
    const status = result.status === null ? "not-observed" : String(result.status);
    lines.push(
      `${result.surface}: status=${status} category=${result.category} retry=${result.retry}`,
      `  guidance: ${result.guidance}`,
    );
  }
  lines.push(`next: ${report.nextAction}`);
  return lines.join("\n");
}

function runSelfTest() {
  const report = diagnose(DEFAULT_OBSERVATIONS);
  assert.equal(report.observed, 3);
  assert.equal(report.unavailable, 3);
  assert.equal(report.complete, true);
  assert.deepEqual(
    report.results.map((result) => result.category),
    [
      "temporarily_unavailable",
      "temporarily_unavailable",
      "temporarily_unavailable",
    ],
  );
  assert.ok(report.results.every((result) => result.retry === true));

  const partial = diagnose([{ surface: "x402_info", status: 200 }]);
  assert.equal(partial.complete, false);
  assert.equal(partial.results[0].category, "available");
  assert.equal(partial.results[1].category, "not_observed");

  const clientError = diagnose([{ surface: "x402_manifest", status: 404 }]);
  assert.equal(clientError.results[2].retry, false);
  assert.equal(clientError.results[2].category, "request_or_route_failure");

  assert.throws(() => diagnose([{ surface: "unknown", status: 503 }]), RangeError);
  assert.throws(() => diagnose([{ surface: "x402_info", status: 99 }]), RangeError);

  const rendered = formatReport(report);
  assert.match(rendered, /x402_info: status=503/);
  assert.match(rendered, /Retry with bounded exponential backoff/);

  console.log(rendered);
  console.log("AGOS_RUNTIME_OK");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSelfTest();
}
