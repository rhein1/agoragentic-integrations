import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DISCOVERY_UNAVAILABLE = 503;
const DISCOVERY_READY = 200;
const EXECUTION_SUCCESS = 200;
const EXECUTION_NOT_ATTEMPTED = "not_attempted";

function makeDiscoveryFixture(status = DISCOVERY_UNAVAILABLE) {
  return Object.freeze({
    surface: "discovery",
    status,
    capturedOffline: true,
    source: "local-regression-fixture",
  });
}

function makeExecutionFixture(status = EXECUTION_NOT_ATTEMPTED) {
  return Object.freeze({
    surface: "buyer_execution",
    status,
    capturedOffline: true,
    source: "local-regression-fixture",
  });
}

function classifyDiscovery(result) {
  if (!result || result.surface !== "discovery") {
    return {
      code: "invalid_discovery_fixture",
      summary: "The fixture does not describe the discovery surface.",
      execution: "unknown",
    };
  }

  if (result.status === DISCOVERY_UNAVAILABLE) {
    return {
      code: "discovery_unavailable",
      summary: "Discovery is unavailable; buyer execution was not tested.",
      execution: "separate_failure_domain",
    };
  }

  if (result.status === DISCOVERY_READY) {
    return {
      code: "discovery_available",
      summary: "Discovery is available for a bounded buyer-flow check.",
      execution: "eligible_for_separate_check",
    };
  }

  return {
    code: "discovery_unexpected_status",
    summary: `Discovery returned an unexpected offline status: ${String(result.status)}.`,
    execution: "not_concluded",
  };
}

function diagnose(discovery, execution = makeExecutionFixture()) {
  const finding = classifyDiscovery(discovery);
  const executionObserved =
    execution &&
    execution.surface === "buyer_execution" &&
    execution.status !== EXECUTION_NOT_ATTEMPTED;

  const nextAction =
    finding.code === "discovery_unavailable"
      ? "Goose: restore the discovery surface, then rerun this fixture and the focused buyer-flow test."
      : finding.code === "discovery_available" && !executionObserved
        ? "Goose: run the focused buyer-flow test; keep paid conversion validation separate."
        : finding.code === "discovery_available" && execution.status === EXECUTION_SUCCESS
          ? "Human: review the offline evidence before authorizing any live paid-conversion validation."
          : "Human: inspect the bounded fixture inputs before proceeding.";

  return Object.freeze({
    code: finding.code,
    summary: finding.summary,
    discoveryStatus: discovery?.status ?? null,
    executionStatus: execution?.status ?? null,
    executionFailureSeparated:
      finding.code === "discovery_unavailable" &&
      execution?.status === EXECUTION_NOT_ATTEMPTED,
    nextAction,
    paidConversionGate:
      finding.code === "discovery_available" && executionObserved
        ? "Validate paid conversion only after owner approval and a separately authorized live check."
        : "Blocked until discovery and buyer execution are independently healthy.",
  });
}

function renderReport(result) {
  return [
    `diagnosis=${result.code}`,
    `discovery_status=${String(result.discoveryStatus)}`,
    `execution_status=${String(result.executionStatus)}`,
    `execution_failure_separated=${String(result.executionFailureSeparated)}`,
    `next_action=${result.nextAction}`,
    `paid_conversion_gate=${result.paidConversionGate}`,
  ].join("\n");
}

function writeFixtureCopy(directory) {
  const file = path.join(directory, "unavailable-discovery.json");
  const contents = `${JSON.stringify(
    {
      discovery: makeDiscoveryFixture(),
      buyerExecution: makeExecutionFixture(),
    },
    null,
    2,
  )}\n`;
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

function readFixtureCopy(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    discovery: Object.freeze(parsed.discovery),
    buyerExecution: Object.freeze(parsed.buyerExecution),
  };
}

function runSelfTest() {
  const cases = [
    {
      name: "503 separates discovery from execution",
      discovery: makeDiscoveryFixture(),
      execution: makeExecutionFixture(),
      check(result) {
        assert.equal(result.code, "discovery_unavailable");
        assert.equal(result.executionFailureSeparated, true);
        assert.match(result.nextAction, /restore the discovery surface/);
      },
    },
    {
      name: "ready discovery requests a separate buyer check",
      discovery: makeDiscoveryFixture(DISCOVERY_READY),
      execution: makeExecutionFixture(),
      check(result) {
        assert.equal(result.code, "discovery_available");
        assert.equal(result.executionFailureSeparated, false);
        assert.match(result.nextAction, /focused buyer-flow test/);
      },
    },
    {
      name: "successful execution still gates paid validation",
      discovery: makeDiscoveryFixture(DISCOVERY_READY),
      execution: makeExecutionFixture(EXECUTION_SUCCESS),
      check(result) {
        assert.equal(result.code, "discovery_available");
        assert.match(result.paidConversionGate, /owner approval/);
      },
    },
    {
      name: "unexpected status remains bounded",
      discovery: makeDiscoveryFixture(418),
      execution: makeExecutionFixture(),
      check(result) {
        assert.equal(result.code, "discovery_unexpected_status");
        assert.match(result.nextAction, /inspect the bounded fixture/);
      },
    },
    {
      name: "invalid surface is not treated as execution failure",
      discovery: { surface: "other", status: 503 },
      execution: makeExecutionFixture(),
      check(result) {
        assert.equal(result.code, "invalid_discovery_fixture");
        assert.equal(result.executionFailureSeparated, false);
      },
    },
  ];

  for (const testCase of cases) {
    const result = diagnose(testCase.discovery, testCase.execution);
    testCase.check(result);
    process.stdout.write(`ok - ${testCase.name}\n`);
  }

  const tempDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agoragentic-discovery-"),
  );
  const fixtureFile = writeFixtureCopy(tempDirectory);
  const loaded = readFixtureCopy(fixtureFile);
  const loadedResult = diagnose(loaded.discovery, loaded.buyerExecution);
  assert.equal(loadedResult.code, "discovery_unavailable");
  assert.equal(loadedResult.executionStatus, EXECUTION_NOT_ATTEMPTED);
  fs.rmSync(tempDirectory, { recursive: true, force: true });
  process.stdout.write("fixture round-trip passed\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSelfTest();
  process.stdout.write("AGOS_RUNTIME_OK\n");
}

export {
  DISCOVERY_READY,
  DISCOVERY_UNAVAILABLE,
  EXECUTION_NOT_ATTEMPTED,
  EXECUTION_SUCCESS,
  classifyDiscovery,
  diagnose,
  makeDiscoveryFixture,
  makeExecutionFixture,
  renderReport,
};
