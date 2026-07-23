#!/usr/bin/env node
// Publishability smoke test (acceptance gate).
//
// Packs the package, installs the tarball into a clean throwaway project OUTSIDE
// the monorepo, imports the adapter-facing kernel/schema subpaths, and runs
// init/validate/run via the INSTALLED bin. This catches root-relative imports,
// missing runtime dependencies, broken exports, and a broken files[] allowlist
// — the failure modes that pass inside the monorepo but break after `npm
// publish`. Exits non-zero on any failure.
//
//   node packages/harness-core/scripts/pack-smoke.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');
const work = mkdtempSync(path.join(tmpdir(), 'harness-pack-smoke-'));
const packDest = path.join(work, 'pack');
const consumer = path.join(work, 'consumer');
mkdirSync(packDest, { recursive: true });
mkdirSync(consumer, { recursive: true });

function run(cmd, args, cwd, shell = false) {
  // npm is a .cmd shim on Windows; Node 20 requires shell:true to spawn it.
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell });
}
function cleanup() {
  try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
}
function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  cleanup();
  process.exit(1);
}

try {
  run(npm, ['pack', '--pack-destination', packDest], pkgDir, true);
  const tgz = readdirSync(packDest).find((file) => file.endsWith('.tgz'));
  if (!tgz) fail('npm pack produced no tarball');
  const tarball = path.join(packDest, tgz);

  writeFileSync(
    path.join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'smoke-consumer', private: true, version: '1.0.0' }, null, 2)}\n`,
  );
  run(npm, ['install', tarball, '--no-audit', '--no-fund'], consumer, true);
  const schemaFiles = readdirSync(path.join(pkgDir, 'schema'))
    .filter((file) => file.endsWith('.json'))
    .sort();

  const importCheck = JSON.parse(run(process.execPath, [
    '--input-type=module',
    '--eval',
    `
      import { createRequire } from 'node:module';
      const runModule = await import('agoragentic-harness-core/kernel/run');
      const registryModule = await import('agoragentic-harness-core/kernel/middleware-registry');
      const require = createRequire(import.meta.url);
      const schemas = ${JSON.stringify(schemaFiles)};
      const resolvedSchemas = schemas.map((schema) => require.resolve('agoragentic-harness-core/schema/' + schema));
      console.log(JSON.stringify({
        run: typeof runModule.executeHarnessRun === 'function',
        registry: typeof registryModule.MiddlewareRegistry === 'function',
        schemas: resolvedSchemas.length === schemas.length,
      }));
    `,
  ], consumer));
  if (!importCheck.run || !importCheck.registry || !importCheck.schemas) {
    fail(`installed package subpath import failed: ${JSON.stringify(importCheck)}`);
  }

  const bin = path.join(consumer, 'node_modules', 'agoragentic-harness-core', 'bin', 'agoragentic-harness.mjs');
  const init = JSON.parse(run(process.execPath, [bin, 'init'], consumer));
  if (!init.ok) fail('init did not return ok');
  const validate = JSON.parse(run(process.execPath, [bin, 'validate'], consumer));
  if (!validate.ok) fail(`validate reported issues: ${JSON.stringify(validate.issues || [])}`);
  const result = JSON.parse(run(process.execPath, [bin, 'run'], consumer));
  if (result.status !== 'passed') fail(`run status was ${result.status}`);

  console.log('SMOKE OK: packed, installed outside the monorepo, subpath imports and init/validate/run all passed.');
  cleanup();
  process.exit(0);
} catch (err) {
  fail(err.stderr ? `${err.message}\n${err.stderr}` : err.message || String(err));
}
