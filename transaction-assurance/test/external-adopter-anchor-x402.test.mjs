import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import test from 'node:test';

import {
  readJson,
  runConformanceSuite,
  verifyConformanceReceipt,
} from '../src/conformance.mjs';
import { evaluateTransactionAssuranceVector } from '../examples/external-adopters/anchor-x402/target.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = path.resolve(packageRoot, '..');
const packRoot = path.join(packageRoot, 'examples', 'external-adopters', 'anchor-x402');
const manifest = await readJson(path.join(packageRoot, 'conformance', 'manifest.v1.json'));
const vectorSet = await readJson(path.join(packageRoot, 'conformance', 'vectors.v1.json'));

test('anchor-x402 clean-room target satisfies the bounded normalized contract', async () => {
  const report = await runConformanceSuite({
    manifest,
    vectorSet,
    evaluate: evaluateTransactionAssuranceVector,
    target: { name: 'anchor-x402-test', version: '0.1.0', commit: 'fixture' },
  });
  assert.equal(report.total, 42);
  assert.equal(report.failed, 0);
  assert.equal(report.all_passed, true);
  assert.deepEqual(evaluateTransactionAssuranceVector(), {
    decision: 'deny',
    code: 'malformed_normalized_input',
  });
  const unknownProtocol = structuredClone(vectorSet.base_input);
  unknownProtocol.protocol = { adapter_id: 'unknown', source_version: '1' };
  assert.deepEqual(evaluateTransactionAssuranceVector({ input: unknownProtocol }), {
    decision: 'deny',
    code: 'unsupported_protocol_version',
  });
});

test('anchor-x402 target has no circular reference, network, secret, or expected-answer dependency', async () => {
  const source = await readFile(path.join(packRoot, 'target.mjs'), 'utf8');
  for (const forbidden of [
    /evaluateReferenceVector/,
    /vector\s*\.\s*expected/,
    /from\s+['"]node:(?:http|https|net|tls|dgram)/,
    /\bfetch\s*\(/,
    /process\s*\.\s*env/,
    /child_process/,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }

  const profile = await readJson(path.join(packRoot, 'profile.v1.json'));
  for (const field of [
    'network_required',
    'secret_access_required',
    'spend_authority',
    'wire_protocol_parsing_claimed',
    'signature_verification_claimed',
    'live_settlement_claimed',
    'production_compatibility_claimed',
    'certification_claimed',
  ]) assert.equal(profile[field], false, field);
  assert.equal(profile.operator_review_required, true);
});

test('portable runner binds clean target and suite commits and emits verifiable artifacts', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'anchor-x402-adopter-'));
  const targetRoot = path.join(temp, 'target');
  try {
    const copiedPack = path.join(targetRoot, 'tools', 'anchor-x402');
    await mkdir(copiedPack, { recursive: true });
    for (const filename of ['profile.v1.json', 'run.mjs', 'target.mjs']) {
      await cp(path.join(packRoot, filename), path.join(copiedPack, filename));
    }
    await execFileAsync('git', ['init'], { cwd: targetRoot });
    await execFileAsync('git', ['config', 'user.name', 'Conformance Test'], { cwd: targetRoot });
    await execFileAsync('git', ['config', 'user.email', 'conformance@example.invalid'], { cwd: targetRoot });
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: targetRoot });
    await execFileAsync('git', ['add', 'tools/anchor-x402'], { cwd: targetRoot });
    await execFileAsync('git', ['commit', '-m', 'test: add adopter pack'], { cwd: targetRoot });

    const suiteCommit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
    const runner = path.join(copiedPack, 'run.mjs');
    const args = [runner, '--suite-root', packageRoot, '--suite-commit', suiteCommit];
    const first = await execFileAsync(process.execPath, args, { cwd: targetRoot });
    const firstSummary = JSON.parse(first.stdout);
    assert.equal(firstSummary.status, 'passed');
    assert.equal(firstSummary.total, 42);
    assert.equal(firstSummary.failed, 0);

    const output = path.join(targetRoot, 'artifacts', 'agoragentic-transaction-assurance');
    const report = await readJson(path.join(output, 'report.json'));
    const receipt = await readJson(path.join(output, 'receipt.json'));
    const context = await readJson(path.join(output, 'adopter-context.json'));
    assert.equal(context.suite_commit, suiteCommit);
    assert.equal(context.target_commit, report.target.commit);
    assert.equal(context.network_used_by_suite, false);
    assert.equal(context.spend_authority_granted, false);
    assert.match(context.runner_source_hash, /^sha256:[0-9a-f]{64}$/);
    assert.match(context.target_source_hash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(verifyConformanceReceipt({ manifest, vectorSet, report, receipt }), {
      verified: true,
      receipt_hash: receipt.receipt_hash,
    });

    const before = await Promise.all([
      readFile(path.join(output, 'report.json'), 'utf8'),
      readFile(path.join(output, 'receipt.json'), 'utf8'),
      readFile(path.join(output, 'adopter-context.json'), 'utf8'),
    ]);
    await execFileAsync(process.execPath, args, { cwd: targetRoot });
    const after = await Promise.all([
      readFile(path.join(output, 'report.json'), 'utf8'),
      readFile(path.join(output, 'receipt.json'), 'utf8'),
      readFile(path.join(output, 'adopter-context.json'), 'utf8'),
    ]);
    assert.deepEqual(after, before);

    await assert.rejects(
      execFileAsync(process.execPath, [...args, '--output-dir', path.join('..', 'outside')], { cwd: targetRoot }),
      /--output-dir must remain inside the target repository/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
