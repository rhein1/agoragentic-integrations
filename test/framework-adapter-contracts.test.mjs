import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";


const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const adapters = [
  ["AutoGen", "autogen/adapter.test.py"],
  ["ClawTeam", "clawteam/adapter.test.py"],
  ["CrewAI", "crewai/adapter.test.py"],
  ["Griptape", "griptape/adapter.test.py"],
  ["LangChain", "langchain/adapter.test.py"],
  ["LiveKit Agents", "livekit-agents/adapter.test.py"],
  ["Pipecat", "pipecat/adapter.test.py"],
  ["smolagents", "smolagents/adapter.test.py"],
  ["Claude Agent SDK + commerce fixture", "claude-agent-sdk/adapter.test.py"],
  ["Syrin", "syrin/adapter.test.py"],
];

for (const [name, relativePath] of adapters) {
  test(`${name} adapter passes its hermetic framework contract`, () => {
    const result = spawnSync(
      process.env.ADAPTER_CONFORMANCE_PYTHON || "python",
      [path.join(repoRoot, relativePath)],
      { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /OK/);
  });
}

test("Claude Agent SDK TypeScript fail-closed contract", () => {
  const result = spawnSync(process.execPath,
    ["--experimental-strip-types", "--test", "claude-agent-sdk/adapter.test.mjs"],
    { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("Claude Agent SDK catalog copy instruction works in a clean Python project", () => {
  const catalog = JSON.parse(readFileSync(path.join(repoRoot, "integrations.json"), "utf8"));
  const integration = catalog.integrations.find(({ id }) => id === "claude-agent-sdk");
  assert.ok(integration, "claude-agent-sdk catalog entry missing");
  const instruction = /^Copy ([A-Za-z0-9./_-]+) to your project$/.exec(integration.install);
  assert.ok(instruction, `unsupported install instruction: ${integration.install}`);

  const project = mkdtempSync(path.join(tmpdir(), "agoragentic-claude-install-"));
  try {
    const source = path.resolve(repoRoot, instruction[1]);
    copyFileSync(source, path.join(project, path.basename(source)));
    const smoke = path.join(project, "smoke.py");
    writeFileSync(smoke, [
      "from agoragentic_claude_agent import ClaudeAgentSdkGatingAdapter",
      "adapter = ClaudeAgentSdkGatingAdapter()",
      "read_allowed, read_status = adapter.verify_tool_permission('agoragentic_search', {})",
      "paid_allowed, paid_status = adapter.verify_tool_permission(",
      "    'agoragentic_execute', {'constraints': {'max_cost_usdc': '0.01'}})",
      "if not read_allowed or read_status != 'Read_Only_Preflight':",
      "    raise RuntimeError('clean_install_read_preflight_failed')",
      "if paid_allowed or paid_status != 'Approval_Required':",
      "    raise RuntimeError('clean_install_paid_execution_not_blocked')",
    ].join("\n"), "utf8");
    const result = spawnSync(process.env.ADAPTER_CONFORMANCE_PYTHON || "python", [smoke], {
      cwd: project,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
