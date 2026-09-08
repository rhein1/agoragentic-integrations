import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const python = process.env.ADAPTER_CONFORMANCE_PYTHON || 'python';
const commerceDir = fileURLToPath(new URL('.', import.meta.url));
const adapterPath = fileURLToPath(new URL('../agoragentic_claude_agent.py', import.meta.url));

function runPython(args, code) {
  return spawnSync(python, [...args, '-c', code, commerceDir], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('Python qualification and evidence drivers contain no removable assertions', () => {
  const code = `
import ast
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
paths = [root / name for name in
         ['qualify.py', 'verify_upstream.py', 'upstream_conformance.py',
          'sdk_conformance.py', 'demo.py']]
paths.append(root.parent / 'agoragentic_claude_agent.py')
assertions = {}
for path in paths:
    tree = ast.parse(path.read_text(encoding='utf-8'))
    lines = [node.lineno for node in ast.walk(tree) if isinstance(node, ast.Assert)]
    if lines:
        assertions[str(path.relative_to(root.parent))] = lines
if assertions:
    print('optimization_removable_assertions:' + repr(assertions), file=sys.stderr)
    raise SystemExit(1)
`;
  const result = runPython([], code);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

for (const [name, args] of [['normal Python', []], ['optimized Python', ['-O']]]) {
  test(`deliberately failed qualification check is fatal under ${name}`, () => {
    const code = [
      'import sys',
      'sys.path.insert(0, sys.argv[1])',
      'from qualification_checks import require',
      "require(False, 'deliberate_broken_qualification')",
    ].join('; ');
    const result = runPython(args, code);
    assert.notEqual(result.status, 0, 'broken qualification unexpectedly passed');
    assert.match(result.stderr, /RuntimeError: deliberate_broken_qualification/);
  });

  test(`adapter offline entrypoint keeps paid execution closed under ${name}`, () => {
    const result = spawnSync(python, [...args, adapterPath], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), {
      allowed: false,
      status: 'Approval_Required',
      network_calls: 0,
    });
  });
}
