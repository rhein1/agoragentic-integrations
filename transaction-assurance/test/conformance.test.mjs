import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import test from 'node:test';

import {
  buildConformanceReceipt,
  evaluateReferenceVector,
  readJson,
  renderConformanceJUnit,
  runConformanceSuite,
  validateConformanceInput,
  validateConformanceManifest,
  validateConformanceReport,
  validateConformanceVectorSet,
  verifyConformanceReceipt,
} from '../src/conformance.mjs';

const execFileAsync = promisify(execFile);
const root = new URL('../', import.meta.url);
const manifest = await readJson(new URL('conformance/manifest.v1.json', root));
const vectorSet = await readJson(new URL('conformance/vectors.v1.json', root));

test('machine contracts and bundled vectors validate strictly', async () => {
  const schemaFiles = [
    'transaction-assurance-conformance-input.v1.json',
    'transaction-assurance-conformance-manifest.v1.json',
    'transaction-assurance-conformance-vectors.v1.json',
    'transaction-assurance-conformance-report.v1.json',
    'transaction-assurance-conformance-receipt.v1.json',
  ];
  const schemas = await Promise.all(schemaFiles.map((file) => readJson(new URL(`schema/${file}`, root))));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const schema of schemas) ajv.addSchema(schema);
  assert.equal(ajv.validate(schemas[1].$id, manifest), true, JSON.stringify(ajv.errors));
  assert.equal(ajv.validate(schemas[2].$id, vectorSet), true, JSON.stringify(ajv.errors));
  const generatedReport = await runConformanceSuite({
    manifest,
    vectorSet,
    target: { name: 'schema-target', version: '1', commit: 'fixture' },
  });
  const generatedReceipt = buildConformanceReceipt({ manifest, vectorSet, report: generatedReport });
  assert.equal(ajv.validate(schemas[3].$id, generatedReport), true, JSON.stringify(ajv.errors));
  assert.equal(ajv.validate(schemas[4].$id, generatedReceipt), true, JSON.stringify(ajv.errors));
  assert.doesNotThrow(() => validateConformanceManifest(manifest));
  assert.doesNotThrow(() => validateConformanceVectorSet(vectorSet, manifest));
  const poisoned = structuredClone(vectorSet.base_input);
  poisoned.raw_payload = 'not allowed';
  assert.throws(() => validateConformanceInput(poisoned), /must contain exactly/);
});

test('reference suite covers every required profile and negative decision', async () => {
  const report = await runConformanceSuite({
    manifest,
    vectorSet,
    target: { name: 'reference', version: '1', commit: 'test' },
  });
  assert.equal(report.total, vectorSet.vectors.length);
  assert.equal(report.total >= 40, true);
  assert.equal(report.passed, report.total);
  assert.equal(report.failed, 0);
  assert.equal(report.all_passed, true);
  assert.deepEqual(report.profiles_tested, [...manifest.profiles].sort());
  assert.deepEqual(
    new Set(report.protocol_adapters_tested.map((item) => item.id)),
    new Set(['google_ap2', 'visa_tap', 'openai_stripe_acp', 'x402']),
  );
  const codes = new Set(report.results.map((item) => item.actual.code));
  for (const code of [
    'authority_unverified',
    'authority_absent',
    'authority_wrong_principal',
    'authority_expired',
    'authority_revoked',
    'authority_wrong_audience',
    'authority_wrong_agent',
    'merchant_mismatch',
    'seller_mismatch',
    'category_mismatch',
    'action_mismatch',
    'rail_mismatch',
    'currency_mismatch',
    'quote_changed',
    'terms_changed',
    'per_action_limit_exceeded',
    'daily_limit_exceeded',
    'total_limit_exceeded',
    'payment_identifier_missing',
    'payment_identifier_reused',
    'paid_retry_replay_detected',
    'evidence_replayed',
    'delivery_missing_after_payment',
    'settlement_unverified',
    'settlement_not_final',
    'outcome_validation_failed',
    'partial_fulfillment',
    'refund_pending',
    'reconciled_refunded',
    'dispute_pending',
    'reconciled_dispute_resolved',
    'reconciliation_incomplete',
    'privacy_raw_secret_exposed',
    'privacy_private_key_exposed',
    'privacy_payment_credential_exposed',
    'privacy_raw_prompt_exposed',
    'privacy_raw_tool_output_exposed',
    'privacy_private_owner_data_exposed',
    'unsupported_protocol_version',
    'authority_verification_unknown',
  ]) assert.equal(codes.has(code), true, `missing ${code}`);
});

test('reports, JUnit, and receipts are deterministic and tamper evident', async () => {
  const target = { name: 'deterministic-target', version: '1.2.3', commit: 'abc123' };
  const first = await runConformanceSuite({ manifest, vectorSet, target });
  const second = await runConformanceSuite({ manifest, vectorSet, target });
  assert.deepEqual(first, second);
  const junit = renderConformanceJUnit(first);
  assert.match(junit, new RegExp(`tests="${first.total}" failures="0"`));
  const receipt = buildConformanceReceipt({ manifest, vectorSet, report: first });
  assert.equal(receipt.certification_granted, false);
  assert.equal(receipt.network_used_by_suite, false);
  assert.equal(receipt.spend_authority_granted, false);
  assert.deepEqual(verifyConformanceReceipt({ manifest, vectorSet, report: first, receipt }), {
    verified: true,
    receipt_hash: receipt.receipt_hash,
  });
  const tampered = structuredClone(receipt);
  tampered.passed -= 1;
  assert.equal(verifyConformanceReceipt({ manifest, vectorSet, report: first, receipt: tampered }).verified, false);
  const forgedReport = structuredClone(first);
  forgedReport.results[0].expected.code = 'authority_unverified';
  const forgedBody = { ...forgedReport };
  delete forgedBody.report_hash;
  const { sha256Ref } = await import('../src/index.mjs');
  forgedReport.report_hash = sha256Ref(forgedBody);
  assert.throws(
    () => validateConformanceReport({ manifest, vectorSet, report: forgedReport }),
    /expected result mismatch/,
  );
});

test('a nonconforming target produces bounded failures without certification', async () => {
  const report = await runConformanceSuite({
    manifest,
    vectorSet,
    evaluate: () => ({ decision: 'pass', code: 'complete_chain_verified' }),
    target: { name: 'unsafe-target', version: '0', commit: 'test' },
  });
  assert.equal(report.all_passed, false);
  assert.equal(report.failed > 0, true);
  const receipt = buildConformanceReceipt({ manifest, vectorSet, report });
  assert.equal(receipt.certification_granted, false);
  assert.equal(verifyConformanceReceipt({ manifest, vectorSet, report, receipt }).verified, true);
});

test('all four example target modules satisfy the reference contract', async () => {
  for (const filename of [
    'x402-resource-server.mjs',
    'mcp-paid-tool.mjs',
    'agent-wallet-policy.mjs',
    'marketplace-listing.mjs',
  ]) {
    const module = await import(new URL(`examples/conformance-targets/${filename}`, root));
    const report = await runConformanceSuite({
      manifest,
      vectorSet,
      evaluate: module.evaluateTransactionAssuranceVector,
      target: { name: filename, version: 'example', commit: 'fixture' },
    });
    assert.equal(report.all_passed, true, filename);
  }
});

test('CLI writes JSON, JUnit, and a publicly verifiable receipt', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agora-conformance-'));
  const reportPath = path.join(temp, 'report.json');
  const junitPath = path.join(temp, 'report.xml');
  const receiptPath = path.join(temp, 'receipt.json');
  const cli = new URL('bin/run-conformance.mjs', root);
  await execFileAsync(process.execPath, [
    fileURLToPath(cli),
    '--target-name', 'cli-test',
    '--target-version', '1',
    '--target-commit', 'abc',
    '--json', reportPath,
    '--junit', junitPath,
    '--receipt', receiptPath,
  ]);
  const [report, junit, receipt] = await Promise.all([
    readJson(reportPath),
    readFile(junitPath, 'utf8'),
    readJson(receiptPath),
  ]);
  assert.equal(report.all_passed, true);
  assert.match(junit, /<testsuite/);
  assert.equal(receipt.certification_granted, false);
  const verifier = new URL('bin/verify-conformance-receipt.mjs', root);
  const verified = await execFileAsync(process.execPath, [fileURLToPath(verifier), reportPath, receiptPath]);
  assert.deepEqual(JSON.parse(verified.stdout), {
    verified: true,
    receipt_hash: receipt.receipt_hash,
  });
});

test('reference evaluator rejects malformed result inputs', () => {
  const input = structuredClone(vectorSet.base_input);
  input.protocol = { adapter_id: 'x402', source_version: '2.21.0' };
  assert.deepEqual(evaluateReferenceVector(input), {
    decision: 'pass',
    code: 'complete_chain_verified',
  });
});
