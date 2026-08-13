#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const packDirectory = path.dirname(scriptPath);
const commitPattern = /^[0-9a-f]{40}$/;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new TypeError('arguments must be --key value pairs');
    }
    options[key.slice(2)] = value;
  }
  return options;
}

function git(args, cwd) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function assertTrackedAndClean(repositoryRoot, files, label) {
  for (const filename of files) {
    const relative = path.relative(repositoryRoot, filename);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`${label} files must remain inside their repository`);
    }
    git(['ls-files', '--error-unmatch', '--', relative], repositoryRoot);
  }
  const relativeFiles = files.map((filename) => path.relative(repositoryRoot, filename));
  const dirty = git(['status', '--porcelain=v1', '--', ...relativeFiles], repositoryRoot);
  if (dirty) throw new Error(`${label} files must be committed and clean before the evidence run`);
}

function sha256Bytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function resolveInside(root, candidate, field) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${field} must remain inside the target repository`);
  }
  return resolved;
}

async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const suiteCommit = options['suite-commit'];
  if (!commitPattern.test(suiteCommit || '')) {
    throw new TypeError('--suite-commit must be an exact 40-character lowercase Git commit');
  }
  if (!options['suite-root']) throw new TypeError('--suite-root is required');

  const suiteRoot = path.resolve(options['suite-root']);
  const actualSuiteCommit = git(['rev-parse', 'HEAD'], suiteRoot);
  if (actualSuiteCommit !== suiteCommit) {
    throw new Error(`suite checkout mismatch: expected ${suiteCommit}, found ${actualSuiteCommit}`);
  }
  const suiteRepositoryRoot = git(['rev-parse', '--show-toplevel'], suiteRoot);
  assertTrackedAndClean(suiteRepositoryRoot, [
    path.join(suiteRoot, 'src', 'conformance.mjs'),
    path.join(suiteRoot, 'src', 'index.mjs'),
    path.join(suiteRoot, 'src', 'protocol-adapters.mjs'),
    path.join(suiteRoot, 'src', 'trusted-verifier-boundary.mjs'),
    path.join(suiteRoot, 'vendor', 'acp-2026-04-17', 'schema.agentic_checkout.json'),
    path.join(suiteRoot, 'conformance', 'manifest.v1.json'),
    path.join(suiteRoot, 'conformance', 'vectors.v1.json'),
    path.join(suiteRoot, 'package.json'),
    path.join(suiteRoot, 'package-lock.json'),
  ], 'suite evidence');

  const targetRoot = git(['rev-parse', '--show-toplevel'], packDirectory);
  const targetCommit = git(['rev-parse', 'HEAD'], targetRoot);
  if (!commitPattern.test(targetCommit)) throw new Error('target repository HEAD is not an exact Git commit');

  const profilePath = path.join(packDirectory, 'profile.v1.json');
  const targetPath = path.join(packDirectory, 'target.mjs');
  assertTrackedAndClean(targetRoot, [scriptPath, profilePath, targetPath], 'adopter pack');
  const targetModule = await import(pathToFileURL(targetPath).href);
  if (typeof targetModule.evaluateTransactionAssuranceVector !== 'function') {
    throw new Error('target.mjs must export evaluateTransactionAssuranceVector');
  }

  const profileRaw = await readFile(profilePath);
  const profile = JSON.parse(profileRaw.toString('utf8'));
  for (const field of [
    'network_required',
    'secret_access_required',
    'spend_authority',
    'wire_protocol_parsing_claimed',
    'signature_verification_claimed',
    'live_settlement_claimed',
    'production_compatibility_claimed',
    'certification_claimed',
  ]) {
    if (profile[field] !== false) throw new Error(`profile.${field} must remain false`);
  }
  if (profile.operator_review_required !== true) {
    throw new Error('profile.operator_review_required must remain true');
  }
  if (profile.evidence_class !== 'starter_self_test'
    || profile.self_test_satisfies_external_adopter_gate !== false) {
    throw new Error('starter profile must not satisfy the independent external-adopter gate');
  }

  const conformanceUrl = pathToFileURL(path.join(suiteRoot, 'src', 'conformance.mjs')).href;
  const {
    buildConformanceReceipt,
    readJson,
    renderConformanceJUnit,
    runConformanceSuite,
    verifyConformanceReceipt,
  } = await import(conformanceUrl);

  const manifest = await readJson(pathToFileURL(path.join(suiteRoot, 'conformance', 'manifest.v1.json')));
  const vectorSet = await readJson(pathToFileURL(path.join(suiteRoot, 'conformance', 'vectors.v1.json')));
  const report = await runConformanceSuite({
    manifest,
    vectorSet,
    evaluate: targetModule.evaluateTransactionAssuranceVector,
    target: {
      name: profile.target_name,
      version: profile.profile_version,
      commit: targetCommit,
    },
  });
  const receipt = buildConformanceReceipt({ manifest, vectorSet, report });
  const verifiedReceipt = verifyConformanceReceipt({ manifest, vectorSet, report, receipt });
  if (!verifiedReceipt.verified) throw new Error('generated conformance receipt did not verify');

  const outputDirectory = resolveInside(
    targetRoot,
    options['output-dir'] || path.join('artifacts', 'agoragentic-transaction-assurance'),
    '--output-dir',
  );
  const context = {
    schema: 'agoragentic.transaction-assurance.external-adopter-context.v1',
    suite_commit: suiteCommit,
    target_commit: targetCommit,
    target_name: profile.target_name,
    target_version: profile.profile_version,
    operator_display_name: profile.operator_display_name,
    operator_origin: profile.operator_origin,
    evidence_class: profile.evidence_class,
    independent_adopter_run: false,
    self_test_satisfies_external_adopter_gate: false,
    profile_hash: sha256Bytes(profileRaw),
    runner_source_hash: sha256Bytes(await readFile(scriptPath)),
    target_source_hash: sha256Bytes(await readFile(targetPath)),
    report_hash: report.report_hash,
    receipt_hash: receipt.receipt_hash,
    network_used_by_suite: false,
    spend_authority_granted: false,
    operator_review_required: true,
    actionable_observation_template: {
      summary: null,
      affected_profile: null,
      affected_vector_ids: [],
      reproduction: null,
      expected_contract: null,
      observed_contract: null,
      public_evidence_refs: [],
    },
    claim_boundary: manifest.claim_boundary,
  };

  await writeJson(path.join(outputDirectory, 'report.json'), report);
  await writeFile(path.join(outputDirectory, 'junit.xml'), renderConformanceJUnit(report), 'utf8');
  await writeJson(path.join(outputDirectory, 'receipt.json'), receipt);
  await writeJson(path.join(outputDirectory, 'adopter-context.json'), context);

  process.stdout.write(`${JSON.stringify({
    status: report.all_passed ? 'passed' : 'failed',
    total: report.total,
    passed: report.passed,
    failed: report.failed,
    report_hash: report.report_hash,
    receipt_hash: receipt.receipt_hash,
    output_directory: outputDirectory,
    network_used_by_suite: false,
    spend_authority_granted: false,
    evidence_class: profile.evidence_class,
    independent_adopter_run: false,
    external_adopter_gate_satisfied: false,
  })}\n`);
  process.exitCode = report.all_passed ? 0 : 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
