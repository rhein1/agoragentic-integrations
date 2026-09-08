import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const python = process.env.ADAPTER_CONFORMANCE_PYTHON || 'python';
const commerceDir = fileURLToPath(new URL('.', import.meta.url));

function runPython(args, code) {
  return spawnSync(python, [...args, '-c', code, commerceDir], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('qualification driver contains no optimization-removable assertions', () => {
  const code = [
    'import ast, pathlib, sys',
    "tree = ast.parse((pathlib.Path(sys.argv[1]) / 'upstream_conformance.py').read_text(encoding='utf-8'))",
    "assertions = [node.lineno for node in ast.walk(tree) if isinstance(node, ast.Assert)]",
    "print('optimization_removable_assertions:' + ','.join(map(str, assertions)), file=sys.stderr) if assertions else None",
    'raise SystemExit(1 if assertions else 0)',
  ].join('; ');
  const result = runPython([], code);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

for (const [name, args] of [['normal Python', []], ['optimized Python', ['-O']]]) {
  test(`deliberately failed qualification check is fatal under ${name}`, () => {
    const code = [
      'import sys',
      'sys.path.insert(0, sys.argv[1])',
      'from upstream_conformance import require',
      "require(False, 'deliberate_broken_qualification')",
    ].join('; ');
    const result = runPython(args, code);
    assert.notEqual(result.status, 0, 'broken qualification unexpectedly passed');
    assert.match(result.stderr, /RuntimeError: deliberate_broken_qualification/);
  });
}
