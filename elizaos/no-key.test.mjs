import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

for (const script of ['example.js', 'elizaos-example.js']) {
  test(`${script} requires a pre-provisioned key without registering`, () => {
    const env = { ...process.env };
    delete env.AGORAGENTIC_API_KEY;
    env.AGORAGENTIC_BASE_URL = 'http://127.0.0.1:9';

    const result = spawnSync(process.execPath, [path.join(root, script)], {
      cwd: root,
      encoding: 'utf8',
      env,
      timeout: 5_000,
      windowsHide: true,
    });

    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.equal(result.status, 1);
    assert.match(output, /AGORAGENTIC_API_KEY is required/);
    assert.doesNotMatch(output, /Registering new agent|Registered:|API Key:/);
    assert.equal(result.error, undefined);
  });
}
