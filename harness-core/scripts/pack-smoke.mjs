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
//   node harness-core/scripts/pack-smoke.mjs

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
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

function localMarkdownTargets(markdown) {
  const inlineTargets = [...markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)]
    .map((match) => match[1]);
  const referenceTargets = [...markdown.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(\S+)/gm)]
    .map((match) => match[1]);

  return [...new Set([...inlineTargets, ...referenceTargets])]
    .map((target) => target.replace(/^<|>$/g, ''))
    .filter((target) => target && !/^(?:https?:|mailto:|#)/i.test(target));
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
  const installedPackageRoot = path.join(consumer, 'node_modules', 'agoragentic-harness-core');
  const installedReadmePath = path.join(installedPackageRoot, 'README.md');
  const installedHeroPath = path.join(installedPackageRoot, 'assets', 'harness-core-product-hero.svg');
  if (!existsSync(installedHeroPath)) fail('installed package is missing assets/harness-core-product-hero.svg');

  const installedReadme = readFileSync(installedReadmePath, 'utf8');
  for (const target of localMarkdownTargets(installedReadme)) {
    const fileTarget = decodeURIComponent(target.split('#')[0].split('?')[0]);
    if (!fileTarget) continue;
    const resolved = path.resolve(installedPackageRoot, fileTarget);
    const relative = path.relative(installedPackageRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      fail(`installed README link escapes the npm package: ${target}`);
    }
    if (!existsSync(resolved)) fail(`installed README link target is missing: ${target}`);
  }

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

  console.log('SMOKE OK: packed, installed outside the monorepo, README assets/links, subpath imports, and init/validate/run all passed.');
  cleanup();
  process.exit(0);
} catch (err) {
  fail(err.stderr ? `${err.message}\n${err.stderr}` : err.message || String(err));
}
