import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";


const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const adapters = [
  ["Griptape", "griptape/adapter.test.py"],
  ["LiveKit Agents", "livekit-agents/adapter.test.py"],
  ["Pipecat", "pipecat/adapter.test.py"],
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
