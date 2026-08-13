import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as coordinator from "../scripts/adapter-conformance-agent.mjs";

const fixtureWorker = fileURLToPath(new URL("./fixtures/adapter-conformance-fast-exit-worker.mjs", import.meta.url));
const silentWorker = fileURLToPath(new URL("./fixtures/adapter-conformance-silent-worker.mjs", import.meta.url));
const crashWorker = fileURLToPath(new URL("./fixtures/adapter-conformance-crash-worker.mjs", import.meta.url));
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const integration = {
  id: "fast-exit-fixture",
  name: "Fast exit fixture",
  language: "javascript",
  status: "beta",
  path: "fixture.mjs",
  docs: "README.md",
};

test("a worker holds clean exit until the coordinator acknowledges its evidence", async () => {
  assert.equal(
    typeof coordinator.runForkedWorker,
    "function",
    "the production worker coordinator must expose the exact fork path for ordering regression tests",
  );

  for (let attempt = 0; attempt < 32; attempt += 1) {
    const result = await coordinator.runForkedWorker(root, integration, {
      timeoutMs: 5_000,
      workerPath: fixtureWorker,
    });
    assert.equal(result.result, "pass", `attempt ${attempt + 1} produced ${JSON.stringify(result.checks)}`);
  }
});

test("clean exit without evidence fails deterministically", async () => {
  const result = await coordinator.runForkedWorker(root, integration, {
    timeoutMs: 5_000,
    workerPath: silentWorker,
  });

  assert.equal(result.result, "fail");
  assert.deepEqual(result.checks[0].evidence, {
    code: "worker_early_exit",
    exit_code: 0,
    signal: null,
    stderr_present: false,
  });
});

test("real worker failure remains visible without waiting for a success message", async () => {
  const result = await coordinator.runForkedWorker(root, integration, {
    timeoutMs: 5_000,
    workerPath: crashWorker,
  });

  assert.equal(result.result, "fail");
  assert.equal(result.checks[0].evidence.code, "worker_early_exit");
  assert.equal(result.checks[0].evidence.exit_code, 23);
});
