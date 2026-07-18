import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sanitizeWorkerEnv, validateIntegration } from "../scripts/adapter-conformance-lib.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const agentPath = path.join(repoRoot, "scripts", "adapter-conformance-agent.mjs");

function fixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "adapter-conformance-"));
}

function write(root, relativePath, contents) {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents, "utf8");
  return absolute;
}

function entry(id, language, primaryPath, docsPath = `${id}/README.md`) {
  return {
    id,
    name: `${id} integration`,
    language,
    status: "beta",
    path: primaryPath,
    install: "fixture only",
    docs: docsPath,
  };
}

test("forked workers inherit runtime paths but not credentials", () => {
  const env = sanitizeWorkerEnv({
    PATH: "/runtime/bin",
    HOME: "/home/test",
    AGORAGENTIC_API_KEY: "amk_should_not_cross_the_worker_boundary",
    AWS_SECRET_ACCESS_KEY: "also-not-inherited",
    WALLET_PRIVATE_KEY: "never-inherited",
  });

  assert.equal(env.PATH, "/runtime/bin");
  assert.equal(env.HOME, "/home/test");
  assert.equal(env.AGORAGENTIC_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.WALLET_PRIVATE_KEY, undefined);
  assert.equal(env.AGORAGENTIC_CONFORMANCE_OFFLINE, "1");
});

test("syntax proof does not execute adapter top-level code", async () => {
  const root = fixtureRoot();
  const marker = path.join(root, "adapter-executed.txt");
  write(root, "demo/adapter.mjs", `
    import fs from "node:fs";
    fs.writeFileSync(${JSON.stringify(marker)}, "unsafe");
    export const agoragentic_execute = () => ({ ok: true });
  `);
  write(root, "demo/README.md", "# Demo\n\nUses agoragentic_execute with fixtures.\n");

  const result = await validateIntegration(root, entry("demo", "javascript", "demo/adapter.mjs", "demo/README.md"));

  assert.equal(result.result, "pass");
  assert.equal(result.evidence_boundary.adapter_code_executed, false);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(result.checks.find((check) => check.id === "primary_syntax").state, "pass");
});

test("credential findings identify the rule and path without echoing the value", async () => {
  const root = fixtureRoot();
  const secret = "amk_1234567890abcdefghijklmnopqrstuvwxyz";
  write(root, "demo/adapter.js", `export const key = "${secret}";\n`);
  write(root, "demo/README.md", "# Demo\n");

  const result = await validateIntegration(root, entry("demo", "javascript", "demo/adapter.js", "demo/README.md"));
  const serialized = JSON.stringify(result);
  const check = result.checks.find((item) => item.id === "credential_literals");

  assert.equal(result.result, "fail");
  assert.equal(check.state, "fail");
  assert.deepEqual(check.evidence.findings, [{ code: "agoragentic_api_key", path: "demo/adapter.js" }]);
  assert.equal(serialized.includes(secret), false);
});

test("syntax diagnostics redact credential-shaped values from offending source lines", async () => {
  const root = fixtureRoot();
  const secret = "amk_abcdefghijklmnopqrstuvwxyz1234567890";
  write(root, "demo/adapter.py", `BROKEN = "${secret}" +\n`);
  write(root, "demo/README.md", "# Demo\n");

  const result = await validateIntegration(root, entry("demo", "python", "demo/adapter.py", "demo/README.md"));
  const serialized = JSON.stringify(result);
  const syntax = result.checks.find((item) => item.id === "primary_syntax");

  assert.equal(result.result, "fail");
  assert.equal(syntax.state, "fail");
  assert.equal(serialized.includes(secret), false);
  assert.match(syntax.evidence.detail, /REDACTED:agoragentic_api_key/);
});

test("repository path escapes fail before reading outside content", async () => {
  const root = fixtureRoot();
  write(root, "demo/README.md", "# Demo\n");
  const result = await validateIntegration(root, entry("demo", "javascript", "../outside.mjs", "demo/README.md"));
  const primary = result.checks.find((check) => check.id === "primary_path");

  assert.equal(result.result, "fail");
  assert.equal(primary.state, "fail");
  assert.equal(primary.evidence.reason, "path_escapes_repository");
});

test("coordinator forks multi-language workers and writes an honest report", () => {
  const root = fixtureRoot();
  const integrations = [
    entry("javascript-demo", "javascript", "javascript-demo/adapter.mjs"),
    entry("python-demo", "python", "python-demo/adapter.py"),
    entry("typescript-demo", "typescript", "typescript-demo/adapter.ts"),
    entry("json-demo", "json", "json-demo/adapter.json"),
  ];
  write(root, "javascript-demo/adapter.mjs", "export const agoragentic_execute = () => null;\n");
  write(root, "python-demo/adapter.py", "def agoragentic_execute():\n    return None\n");
  write(root, "typescript-demo/adapter.ts", "export function agoragentic_execute(input: string): string { return input; }\n");
  write(root, "json-demo/adapter.json", '{"tool":"agoragentic_execute"}\n');
  for (const integration of integrations) write(root, integration.docs, `# ${integration.name}\n\nagoragentic_execute\n`);
  write(root, "integrations.json", `${JSON.stringify({ integrations }, null, 2)}\n`);
  const reportPath = path.join(root, "report.json");

  const run = spawnSync(process.execPath, [
    agentPath,
    "--root", root,
    "--jobs", "2",
    "--report", reportPath,
    "--json",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGORAGENTIC_API_KEY: "amk_must_not_reach_forked_workers_123456",
      WALLET_PRIVATE_KEY: "must-not-reach-forked-workers",
    },
    timeout: 30_000,
  });

  assert.equal(run.status, 0, run.stderr);
  const stdoutReport = JSON.parse(run.stdout);
  const storedReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(stdoutReport.summary.total, 4);
  assert.equal(stdoutReport.summary.failed, 0);
  assert.equal(storedReport.results.length, 4);
  assert.equal(storedReport.execution.forked_workers, 4);
  assert.equal(storedReport.execution.max_concurrency, 2);
  assert.equal(storedReport.evidence_boundary.credential_values_inherited_by_workers, false);
  assert.equal(storedReport.evidence_boundary.wallet_actions_performed, false);
  assert.equal(fs.readFileSync(reportPath, "utf8").includes("must_not_reach"), false);
  assert(storedReport.results.every((result) => result.evidence_boundary.adapter_code_executed === false));
  assert(storedReport.results.every((result) => result.evidence_boundary.wallet_actions_performed === false));
});

test("coordinator exits non-zero and still writes evidence for malformed source", () => {
  const root = fixtureRoot();
  const integrations = [entry("broken", "javascript", "broken/adapter.mjs")];
  write(root, "broken/adapter.mjs", "export function broken( {\n");
  write(root, "broken/README.md", "# Broken\n\nagoragentic_execute\n");
  write(root, "integrations.json", `${JSON.stringify({ integrations }, null, 2)}\n`);
  const reportPath = path.join(root, "report.json");

  const run = spawnSync(process.execPath, [
    agentPath,
    "--root", root,
    "--report", reportPath,
  ], { encoding: "utf8", env: process.env, timeout: 30_000 });

  assert.equal(run.status, 1);
  assert.match(run.stdout, /1 passed, 1 failed|0 passed, 1 failed/);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.summary.failed, 1);
  assert.equal(report.results[0].checks.find((check) => check.id === "primary_syntax").state, "fail");
});
