import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  createE2BRuntimeSdkIntegrityVerifier,
  loadVerifiedE2BRuntimeSdk,
} from '../src/e2b-qualification.mjs';

// Local synthetic code only. No SDK/provider calls, qualification or billing proof.
async function fixture(t, dependency = false) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'risk-fork-sdk-load-provenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = path.join(root, 'node_modules');
  const sdk = path.join(modules, 'e2b');
  await mkdir(path.join(sdk, 'dist'), { recursive: true });
  await writeFile(path.join(sdk, 'package.json'), JSON.stringify({
    name: 'e2b', version: '2.39.0', main: 'dist/index.js',
    ...(dependency ? { dependencies: { 'synthetic-dependency': '1.0.0' } } : {}),
  }));
  const entry = path.join(sdk, 'dist', 'index.js');
  const dep = path.join(modules, 'synthetic-dependency');
  if (dependency) {
    await mkdir(dep, { recursive: true });
    await writeFile(path.join(dep, 'package.json'), JSON.stringify({
      name: 'synthetic-dependency', version: '1.0.0', main: 'index.js',
    }));
    await writeFile(path.join(dep, 'index.js'), 'module.exports = { revision: "before" };\n');
  }
  const before = dependency
    ? 'module.exports = { revision: require("synthetic-dependency").revision };\n'
    : 'module.exports = { revision: "before" };\n';
  await writeFile(entry, before);
  return { root, sdk, entry, dep, before,
    verifier: createE2BRuntimeSdkIntegrityVerifier({ packageDirectory: sdk }) };
}

test('verified SDK loading reuses unchanged exact bytes without a second evaluation', async (t) => {
  const f = await fixture(t);
  const pin = await f.verifier.inspect();
  const first = await loadVerifiedE2BRuntimeSdk(pin, f.verifier);
  const next = await loadVerifiedE2BRuntimeSdk(pin,
    createE2BRuntimeSdkIntegrityVerifier({ packageDirectory: f.sdk }));
  assert.equal(first.module.default.revision, 'before');
  assert.equal(next.module, first.module);
  assert.equal(next.integrity_hash, pin.integrity_hash);
});

test('a new disk pin must not relabel an older SDK module cached by the same verifier', async (t) => {
  const f = await fixture(t);
  const old = await f.verifier.inspect();
  assert.equal((await loadVerifiedE2BRuntimeSdk(old, f.verifier)).module.default.revision, 'before');
  await writeFile(f.entry, 'module.exports = { revision: "after" };\n');
  const current = await f.verifier.inspect();
  assert.notEqual(current.integrity_hash, old.integrity_hash);
  await assert.rejects(loadVerifiedE2BRuntimeSdk(current, f.verifier), /cached|provenance|restart|loaded.*binding/i);
});

test('a new verifier must not relabel the process-cached old SDK after disk replacement', async (t) => {
  const f = await fixture(t);
  await loadVerifiedE2BRuntimeSdk(await f.verifier.inspect(), f.verifier);
  await writeFile(f.entry, 'module.exports = { revision: "after" };\n');
  const next = createE2BRuntimeSdkIntegrityVerifier({ packageDirectory: f.sdk });
  const current = await next.inspect();
  await assert.rejects(loadVerifiedE2BRuntimeSdk(current, next), /cached|provenance|restart|loaded.*binding/i);
});

test('unverified CommonJS preload must not become verified after its disk bytes change', async (t) => {
  const f = await fixture(t);
  assert.equal(createRequire(import.meta.url)(f.entry).revision, 'before');
  await writeFile(f.entry, 'module.exports = { revision: "after" };\n');
  const current = await f.verifier.inspect();
  await assert.rejects(loadVerifiedE2BRuntimeSdk(current, f.verifier), /cached|provenance|restart|loaded.*binding/i);
});

test('unverified cached transitive code must be rejected before the SDK entry imports', async (t) => {
  const f = await fixture(t, true);
  const require = createRequire(import.meta.url);
  assert.equal(require(path.join(f.dep, 'index.js')).revision, 'before');
  await writeFile(path.join(f.dep, 'index.js'), 'module.exports = { revision: "after" };\n');
  const current = await f.verifier.inspect();
  await assert.rejects(loadVerifiedE2BRuntimeSdk(current, f.verifier), /cached|provenance|restart|loaded.*binding/i);
  assert.equal(Object.hasOwn(require.cache, f.entry), false, 'root evaluation must not begin');
});

test('direct CJS import is not retroactively adopted as verifier cache provenance', async (t) => {
  const f = await fixture(t);
  assert.equal((await import(pathToFileURL(f.entry).href)).default.revision, 'before');
  await assert.rejects(loadVerifiedE2BRuntimeSdk(await f.verifier.inspect(), f.verifier), /cached|provenance|restart/i);
});

test('concurrent factories serialize loading and converge on one verified namespace', async (t) => {
  const f = await fixture(t);
  const pin = await f.verifier.inspect();
  const next = createE2BRuntimeSdkIntegrityVerifier({ packageDirectory: f.sdk });
  const [a, b] = await Promise.all([
    loadVerifiedE2BRuntimeSdk(pin, f.verifier), loadVerifiedE2BRuntimeSdk(pin, next),
  ]);
  assert.equal(a.module, b.module);
  assert.equal(a.integrity_hash, b.integrity_hash);
});

test('failed import remains poisoned rather than silently retrying its partial module graph', async (t) => {
  const f = await fixture(t);
  await writeFile(f.entry, 'throw new Error("synthetic evaluation failure");\n');
  const pin = await f.verifier.inspect();
  await assert.rejects(loadVerifiedE2BRuntimeSdk(pin, f.verifier), /synthetic evaluation failure/);
  const next = createE2BRuntimeSdkIntegrityVerifier({ packageDirectory: f.sdk });
  await assert.rejects(loadVerifiedE2BRuntimeSdk(pin, next), /failed|restart|provenance/i);
});

test('cache eviction or substitution cannot make a verified entry safe to import again', async (t) => {
  const f = await fixture(t);
  const pin = await f.verifier.inspect();
  const original = await loadVerifiedE2BRuntimeSdk(pin, f.verifier);
  const require = createRequire(import.meta.url);
  const cached = require.cache[f.entry];
  delete require.cache[f.entry];
  await assert.rejects(loadVerifiedE2BRuntimeSdk(pin, f.verifier), /loaded.*binding|restart|provenance/i);
  require.cache[f.entry] = { ...cached };
  await assert.rejects(loadVerifiedE2BRuntimeSdk(pin, f.verifier), /cached|restart|provenance/i);
  require.cache[f.entry] = cached;
  assert.equal((await loadVerifiedE2BRuntimeSdk(pin, f.verifier)).module, original.module);
});

test('an ESM root claiming the CJS SDK identity is rejected instead of trusting an opaque ESM cache', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.sdk, 'package.json'), JSON.stringify({
    name: 'e2b', version: '2.39.0', main: 'dist/index.js', type: 'module',
  }));
  await assert.rejects(f.verifier.inspect(), /CommonJS.*profile/i);
});
