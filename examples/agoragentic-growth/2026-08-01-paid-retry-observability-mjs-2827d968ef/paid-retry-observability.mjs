import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

// Offline observability example only: no funds move, no settlement occurs, and
// payment evidence is caller-supplied demo data rather than on-chain proof.

const DEFAULT_MAX_ATTEMPTS = 3;

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeOutcome(outcome) {
  if (!isPlainRecord(outcome)) {
    throw new TypeError("outcome must be an object");
  }

  const status = String(outcome.status ?? "unknown");
  const detail = String(outcome.detail ?? "");
  const paymentEvidence = outcome.paymentEvidence === true;
  const paid = status === "completed" && paymentEvidence;

  return Object.freeze({
    status,
    detail,
    paymentEvidence,
    paid,
  });
}

function createOutcomeRecorder() {
  const outcomes = new Map();

  return Object.freeze({
    record(requestId, outcome) {
      if (!requestId || typeof requestId !== "string") {
        throw new TypeError("requestId must be a non-empty string");
      }

      const normalized = normalizeOutcome(outcome);
      const existing = outcomes.get(requestId);

      if (existing) {
        return existing;
      }

      outcomes.set(requestId, normalized);
      return normalized;
    },

    get(requestId) {
      return outcomes.get(requestId);
    },

    entries() {
      return [...outcomes.entries()];
    },
  });
}

function validateAttempt(attempt, index) {
  if (!isPlainRecord(attempt)) {
    throw new TypeError(`attempt ${index + 1} must be an object`);
  }

  const status = String(attempt.status ?? "unknown");
  const detail = String(attempt.detail ?? "");

  return Object.freeze({
    status,
    detail,
    authenticated: attempt.authenticated === true,
    paymentEvidence: attempt.paymentEvidence === true,
  });
}

function classifyAttempt(attempt) {
  if (!attempt.authenticated) {
    return { status: "unresolved", detail: "authentication was not confirmed" };
  }

  if (attempt.status === "completed") {
    return {
      status: "completed",
      detail: attempt.detail || "authenticated completion recorded",
      paymentEvidence: attempt.paymentEvidence,
    };
  }

  if (attempt.status === "retryable") {
    return { status: "retryable", detail: attempt.detail || "retryable failure" };
  }

  return { status: "unresolved", detail: attempt.detail || "non-retryable failure" };
}

function runBoundedBuyerCompletion({
  requestId,
  attempts,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  recorder = createOutcomeRecorder(),
}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }

  if (!Array.isArray(attempts)) {
    throw new TypeError("attempts must be an array");
  }

  const trace = [];
  let outcome = null;
  const limit = Math.min(attempts.length, maxAttempts);

  for (let index = 0; index < limit; index += 1) {
    const observed = validateAttempt(attempts[index], index);
    const classified = classifyAttempt(observed);

    trace.push({
      number: index + 1,
      status: classified.status,
      detail: classified.detail,
      authenticated: observed.authenticated,
      paymentEvidence: observed.paymentEvidence,
    });

    if (classified.status === "completed") {
      outcome = recorder.record(requestId, classified);
      break;
    }

    if (classified.status !== "retryable") {
      outcome = recorder.record(requestId, classified);
      break;
    }
  }

  if (!outcome) {
    outcome = recorder.record(requestId, {
      status: "unresolved",
      detail: `retry budget exhausted after ${trace.length} attempt(s)`,
    });
  }

  return Object.freeze({
    requestId,
    attemptsObserved: trace.length,
    retryBudget: maxAttempts,
    outcome,
    trace: Object.freeze(trace),
  });
}

function summarize(results) {
  const lines = ["Paid completion reconciliation", ""];

  for (const result of results) {
    const state = result.outcome.paid
      ? "PAID_WITH_EVIDENCE"
      : result.outcome.status === "completed"
        ? "COMPLETED_UNVERIFIED"
        : "UNRESOLVED";
    lines.push(
      `${result.requestId}: ${state}; attempts=${result.attemptsObserved}/${result.retryBudget}; ` +
        `detail=${result.outcome.detail}`,
    );

    for (const event of result.trace) {
      lines.push(
        `  attempt ${event.number}: ${event.status}; ` +
          `authenticated=${event.authenticated ? "yes" : "no"}; ` +
          `payment_evidence=${event.paymentEvidence ? "yes" : "no"}; ${event.detail}`,
      );
    }
  }

  const paid = results.filter((result) => result.outcome.paid).length;
  const completedUnverified = results.filter((result) => (
    result.outcome.status === "completed" && !result.outcome.paid
  )).length;
  const unresolved = results.filter((result) => result.outcome.status !== "completed").length;

  lines.push("");
  lines.push(`totals: paid_with_evidence=${paid}; completed_unverified=${completedUnverified}; unresolved=${unresolved}`);
  return lines.join("\n");
}

function demo() {
  const recorder = createOutcomeRecorder();
  const scenarios = [
    {
      requestId: "purchase-success",
      attempts: [
        { status: "retryable", authenticated: true, detail: "temporary buyer completion failure" },
        {
          status: "completed",
          authenticated: true,
          paymentEvidence: true,
          detail: "paid completion evidence recorded",
        },
      ],
    },
    {
      requestId: "purchase-unresolved",
      attempts: [
        { status: "retryable", authenticated: true, detail: "temporary buyer completion failure" },
        { status: "retryable", authenticated: true, detail: "temporary buyer completion failure" },
        { status: "retryable", authenticated: true, detail: "retry budget reached" },
        { status: "completed", authenticated: true, detail: "late result ignored by bound" },
      ],
    },
  ];

  const results = scenarios.map((scenario) =>
    runBoundedBuyerCompletion({ ...scenario, recorder }),
  );

  console.log(summarize(results));
  return { recorder, results };
}

function selfTest() {
  const cases = [
    {
      name: "success after retry",
      requestId: "success after retry",
      attempts: [
        { status: "retryable", authenticated: true },
        { status: "completed", authenticated: true, paymentEvidence: true },
      ],
      expected: ["completed", 2, true],
    },
    {
      name: "bounded unresolved",
      requestId: "bounded unresolved",
      attempts: [
        { status: "retryable", authenticated: true },
        { status: "retryable", authenticated: true },
        { status: "completed", authenticated: true },
      ],
      maxAttempts: 2,
      expected: ["unresolved", 2, false],
    },
    {
      name: "missing authentication",
      requestId: "missing authentication",
      attempts: [{ status: "completed", authenticated: false }],
      expected: ["unresolved", 1, false],
    },
    {
      name: "non-retryable failure",
      requestId: "non-retryable failure",
      attempts: [{ status: "rejected", authenticated: true, detail: "declined" }],
      expected: ["unresolved", 1, false],
    },
    {
      name: "completion without payment evidence",
      requestId: "completion without payment evidence",
      attempts: [{ status: "completed", authenticated: true }],
      expected: ["completed", 1, false],
    },
  ];

  for (const testCase of cases) {
    const recorder = createOutcomeRecorder();
    const first = runBoundedBuyerCompletion({ ...testCase, recorder });
    const second = recorder.record(testCase.name, { status: "completed" });

    assert.equal(first.outcome.status, testCase.expected[0], testCase.name);
    assert.equal(first.attemptsObserved, testCase.expected[1], testCase.name);
    assert.equal(first.outcome.paid, testCase.expected[2], `${testCase.name}: paid evidence`);
    assert.equal(second.status, first.outcome.status, `${testCase.name}: idempotency`);
    assert.equal(recorder.entries().length, 1, `${testCase.name}: one outcome`);
  }

  assert.throws(
    () => runBoundedBuyerCompletion({ requestId: "bad", attempts: [], maxAttempts: 0 }),
    RangeError,
  );

  const demoResult = demo();
  assert.equal(demoResult.results[0].outcome.status, "completed");
  assert.equal(demoResult.results[0].outcome.paid, true);
  assert.equal(demoResult.results[1].outcome.status, "unresolved");
}

const entrypoint = fileURLToPath(import.meta.url);
const invokedAs = process.argv[1] ? fileURLToPath(pathToFileURL(process.argv[1])) : "";

if (entrypoint === invokedAs || process.argv[1] === undefined) {
  selfTest();
  console.log("AGOS_RUNTIME_OK");
}
