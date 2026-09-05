import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceRoot = new URL('../src/', import.meta.url);
const roots = [
  sourceRoot,
  new URL('../test/', import.meta.url),
];
const sourceOnlyGuards = Object.freeze([
  Object.freeze({
    label: 'network or process runtime import',
    pattern: /from\s+['"](?:node:)?(?:child_process|dgram|dns|http|http2|https|net|tls|worker_threads)['"]/u,
  }),
  Object.freeze({
    label: 'provider SDK import',
    pattern: /from\s+['"](?:@aws-sdk\/|@e2b\/|aws-sdk(?:\/|['"])|e2b(?:\/|['"]))/u,
  }),
  Object.freeze({
    label: 'outbound browser-style API',
    pattern: /\b(?:EventSource|WebSocket|fetch)\s*\(/u,
  }),
  Object.freeze({
    label: 'network listener',
    pattern: /\.listen\s*\(/u,
  }),
]);

let checked = 0;
let sourceOnlyChecked = 0;
for (const root of roots) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') continue;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    const file = new URL(entry.name, root);
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(file)], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) {
      process.stderr.write(result.stderr || result.stdout);
      process.exit(result.status ?? 1);
    }
    if (root === sourceRoot) {
      const source = await readFile(file, 'utf8');
      const failedGuard = sourceOnlyGuards.find((guard) => guard.pattern.test(source));
      if (failedGuard) {
        process.stderr.write(
          `Managed service source-only check rejected ${entry.name}: ${failedGuard.label}.\n`,
        );
        process.exit(1);
      }
      sourceOnlyChecked += 1;
    }
    checked += 1;
  }
}

process.stdout.write(
  `Managed service syntax/source-only check passed (${checked} modules; ${sourceOnlyChecked} runtime modules).\n`,
);
