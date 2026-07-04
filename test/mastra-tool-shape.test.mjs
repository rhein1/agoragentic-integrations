import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function makeMastraFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "mastra-tool-shape-"));
  const adapterDir = path.join(fixture, "mastra");
  const packageDir = path.join(fixture, "node_modules", "@mastra", "core");
  fs.mkdirSync(adapterDir, { recursive: true });
  fs.mkdirSync(packageDir, { recursive: true });
  fs.copyFileSync(
    path.join(root, "mastra", "agoragentic_mastra.js"),
    path.join(adapterDir, "agoragentic_mastra.js"),
  );
  fs.writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify({ type: "module" }, null, 2),
  );
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ type: "module", exports: { "./tools": "./tools.js" } }, null, 2),
  );
  fs.writeFileSync(
    path.join(packageDir, "tools.js"),
    "export function createTool(options) { return { __mastraTool: true, ...options }; }\n",
  );
  return fixture;
}

test("Mastra integration returns createTool-shaped tools", async () => {
  const fixture = makeMastraFixture();
  const mod = await import(pathToFileURL(path.join(fixture, "mastra", "agoragentic_mastra.js")));
  const integration = new mod.AgoragenticIntegration({ apiKey: "amk_test" });
  const tools = integration.getTools();

  assert.equal(tools.agoragentic_execute.__mastraTool, true);
  assert.equal(tools.agoragentic_execute.id, "agoragentic_execute");
  assert.equal(typeof tools.agoragentic_execute.description, "string");
  assert.equal(tools.agoragentic_execute.inputSchema.required[0], "task");
  assert.equal(tools.agoragentic_execute.outputSchema.type, "object");
  assert.equal(typeof tools.agoragentic_execute.execute, "function");
  assert.equal("schema" in tools.agoragentic_execute, false);
  assert.equal("executor" in tools.agoragentic_execute, false);
  assert.equal("label" in tools.agoragentic_execute, false);
});

test("Mastra execute tool still calls Agent OS execute", async () => {
  const fixture = makeMastraFixture();
  const mod = await import(pathToFileURL(path.join(fixture, "mastra", "agoragentic_mastra.js")));
  const integration = new mod.AgoragenticIntegration({ apiKey: "amk_test" });
  const tools = integration.getTools();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      async json() {
        return { ok: true };
      },
    };
  };
  try {
    const result = await tools.agoragentic_execute.execute({
      task: "summarize",
      input: { text: "hello" },
      constraints: { max_cost: 0.01 },
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://agoragentic.com/api/execute");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.headers.Authorization, "Bearer amk_test");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      task: "summarize",
      input: { text: "hello" },
      constraints: { max_cost: 0.01 },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
