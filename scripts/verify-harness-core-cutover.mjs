#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CUTOVER_VERSION = '0.3.1';
export const CURRENT_VERSION = '0.4.2';
export const CUTOVER_AUTHORITY_KEYS = [
  'deployment',
  'hosted_memory',
  'marketplace_publication',
  'owner_approval_bypass',
  'provider_dispatch',
  'spend',
  'trust_mutation',
  'wallet',
  'x402',
];
export const CURRENT_AUTHORITY_KEYS = [
  'deployment',
  'hosted_memory',
  'marketplace_publication',
  'owner_approval_bypass',
  'provider_dispatch',
  'spend',
  'trust_mutation',
  'wallet_mutation',
  'x402_settlement',
];
export const EXPECTED_POINTER_FILES = [
  'CURRENT_RELEASE_EVIDENCE.json',
  'README.md',
  'STANDALONE_RELEASE_EVIDENCE.json',
];
export const EXPECTED_EXAMPLE_POINTER_FILES = ['README.md'];

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), '..');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full).map((child) => path.join(entry.name, child)));
    } else {
      files.push(entry.name);
    }
  }
  return files.map((file) => file.replaceAll('\\', '/')).sort();
}

export function validateHarnessPointerFiles(files) {
  const actual = [...files].sort();
  const expected = [...EXPECTED_POINTER_FILES].sort();
  if (JSON.stringify(actual) === JSON.stringify(expected)) return [];
  return [`harness-core/ must contain only ${expected.join(', ')}; found ${actual.join(', ') || 'nothing'}`];
}

function check(condition, message, errors) {
  if (!condition) errors.push(message);
}

export function validateAllFalseAuthority(record, expectedKeys, label) {
  const actualKeys = record && typeof record === 'object' && !Array.isArray(record)
    ? Object.keys(record).sort()
    : [];
  const requiredKeys = [...expectedKeys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(requiredKeys)) {
    return [`${label} authority evidence keys must equal: ${requiredKeys.join(', ')}`];
  }
  const enabled = Object.entries(record)
    .filter(([, value]) => value !== false)
    .map(([key]) => key);
  return enabled.length ? [`${label} authority evidence enables or misstates: ${enabled.join(', ')}`] : [];
}

export function verifyHarnessCoreCutover({ root = defaultRoot } = {}) {
  const errors = [];
  const pointerRoot = path.join(root, 'harness-core');
  check(fs.existsSync(pointerRoot), 'harness-core/ pointer directory is missing', errors);
  if (!fs.existsSync(pointerRoot)) return { ok: false, errors };

  errors.push(...validateHarnessPointerFiles(listFiles(pointerRoot)));

  const examplePointerRoot = path.join(root, 'examples', 'harness-core-frameworks');
  check(fs.existsSync(examplePointerRoot), 'legacy framework-example pointer directory is missing', errors);
  if (fs.existsSync(examplePointerRoot)) {
    const exampleFiles = listFiles(examplePointerRoot);
    check(
      JSON.stringify(exampleFiles) === JSON.stringify(EXPECTED_EXAMPLE_POINTER_FILES),
      `examples/harness-core-frameworks/ must contain only README.md; found ${exampleFiles.join(', ') || 'nothing'}`,
      errors,
    );
    const exampleReadme = fs.readFileSync(path.join(examplePointerRoot, 'README.md'), 'utf8');
    check(
      exampleReadme.includes('https://github.com/rhein1/agoragentic-harness-core/tree/main/examples/frameworks'),
      'framework-example pointer does not target the standalone examples',
      errors,
    );
  }

  const readme = fs.readFileSync(path.join(pointerRoot, 'README.md'), 'utf8');
  for (const required of [
    'https://github.com/rhein1/agoragentic-harness-core',
    'https://www.npmjs.com/package/agoragentic-harness-core',
    `releases/tag/v${CURRENT_VERSION}`,
    'CURRENT_RELEASE_EVIDENCE.json',
    'STANDALONE_RELEASE_EVIDENCE.json',
    'thin pointer',
  ]) {
    check(readme.includes(required), `harness-core/README.md is missing ${required}`, errors);
  }
  check(/not\s+settlement receipts/.test(readme), 'harness-core/README.md is missing the settlement-receipt boundary', errors);

  const cutoverEvidence = readJson(path.join(pointerRoot, 'STANDALONE_RELEASE_EVIDENCE.json'));
  check(cutoverEvidence.schema === 'agoragentic.harness-core.standalone-release-evidence.v1', 'unexpected cutover evidence schema', errors);
  check(cutoverEvidence.canonical_repository === 'https://github.com/rhein1/agoragentic-harness-core', 'canonical Harness Core repository is not standalone', errors);
  check(cutoverEvidence.source_cutover?.duplicate_canonical_implementation_removed === true, 'duplicate canonical implementation is not recorded as removed', errors);
  check(cutoverEvidence.release?.tag === `v${CUTOVER_VERSION}`, `cutover evidence must remain pinned to v${CUTOVER_VERSION}`, errors);
  check(cutoverEvidence.release?.target_commit === 'be6ecc806c87d332434efa265d0c44efe432028a', 'cutover evidence target commit changed', errors);
  check(cutoverEvidence.npm?.version === CUTOVER_VERSION, `cutover npm evidence must remain pinned to ${CUTOVER_VERSION}`, errors);
  check(cutoverEvidence.npm?.provenance_predicate === 'https://slsa.dev/provenance/v1', 'cutover SLSA provenance evidence is missing', errors);
  check(cutoverEvidence.publishing?.trusted_publisher_repository === 'rhein1/agoragentic-harness-core', 'cutover trusted publisher points at the wrong repository', errors);
  check(cutoverEvidence.publishing?.trusted_publisher_workflow === 'publish.yml', 'cutover trusted publisher workflow must be publish.yml', errors);
  check(cutoverEvidence.publishing?.conclusion === 'success', 'standalone cutover publish workflow is not recorded as successful', errors);
  check(cutoverEvidence.clean_room?.result === 'passed', 'cutover clean-room verification is not recorded as passed', errors);
  errors.push(...validateAllFalseAuthority(cutoverEvidence.authority, CUTOVER_AUTHORITY_KEYS, 'cutover'));

  const currentEvidence = readJson(path.join(pointerRoot, 'CURRENT_RELEASE_EVIDENCE.json'));
  check(currentEvidence.schema === 'agoragentic.harness-core.current-release-evidence.v1', 'unexpected current release evidence schema', errors);
  check(currentEvidence.canonical_repository === 'https://github.com/rhein1/agoragentic-harness-core', 'current release repository is not standalone', errors);
  check(currentEvidence.release?.tag === `v${CURRENT_VERSION}`, `current release evidence must target v${CURRENT_VERSION}`, errors);
  check(currentEvidence.release?.target_commit === 'd858f955023df8094855e36ca23d8399d9460000', 'current release target commit changed', errors);
  check(currentEvidence.npm?.version === CURRENT_VERSION, `current npm evidence must target ${CURRENT_VERSION}`, errors);
  check(currentEvidence.npm?.latest === CURRENT_VERSION, `current npm latest must be ${CURRENT_VERSION}`, errors);
  check(currentEvidence.npm?.shasum === '085288174ab553e81e1dd8e41159c97b81dccb98', 'current npm shasum changed', errors);
  check(currentEvidence.npm?.provenance_predicate === 'https://slsa.dev/provenance/v1', 'current SLSA provenance evidence is missing', errors);
  check(currentEvidence.publishing?.trusted_publisher_workflow === 'publish.yml', 'current trusted publisher workflow must be publish.yml', errors);
  check(currentEvidence.publishing?.github_environment === 'npm-publish', 'current publish evidence must use npm-publish', errors);
  check(currentEvidence.publishing?.workflow_run_id === 33138725802, 'current publish workflow run changed', errors);
  check(currentEvidence.publishing?.event === 'push', 'current publish workflow must be tag-push triggered', errors);
  check(currentEvidence.publishing?.conclusion === 'success', 'current publish workflow is not recorded as successful', errors);
  check(currentEvidence.publishing?.environment_approval?.independent_human_review === false, 'solo-maintainer environment approval is misclassified', errors);
  check(currentEvidence.clean_room?.declared_exports === 38, 'current clean-room evidence must cover all 38 exports', errors);
  check(currentEvidence.clean_room?.result === 'passed', 'current clean-room published-package verification is not recorded as passed', errors);
  check(currentEvidence.ahp_observer?.protocol_version === '0.8.0', 'current AHP protocol evidence changed', errors);
  check(currentEvidence.ahp_observer?.authority_flags_false === 20, 'current AHP adapter authority evidence is incomplete', errors);
  check(currentEvidence.ahp_observer?.base_authority_booleans_false === 30, 'current AHP base-authority evidence is incomplete', errors);
  check(Object.keys(currentEvidence.ahp_observer?.authority_flags || {}).length === 20, 'current AHP adapter authority flag inventory is incomplete', errors);
  check(Object.values(currentEvidence.ahp_observer?.authority_flags || {}).every((value) => value === false), 'current AHP adapter authority inventory grants authority', errors);
  const baseAuthority = currentEvidence.ahp_observer?.base_authority || {};
  check(baseAuthority.mode === 'local_no_spend', 'current AHP base-authority mode changed', errors);
  const baseAuthorityFlags = Object.entries(baseAuthority).filter(([key]) => key !== 'mode');
  check(baseAuthorityFlags.length === 30, 'current AHP base-authority flag inventory is incomplete', errors);
  check(baseAuthorityFlags.every(([, value]) => value === false), 'current AHP base-authority inventory grants authority', errors);
  errors.push(...validateAllFalseAuthority(currentEvidence.authority, CURRENT_AUTHORITY_KEYS, 'current release'));

  const manifest = readJson(path.join(root, 'integrations.json'));
  check(manifest.packages?.harness_core?.version === CURRENT_VERSION, `manifest Harness Core package must be ${CURRENT_VERSION}`, errors);
  const integrations = new Map(manifest.integrations.map((entry) => [entry.id, entry]));
  for (const id of ['harness-core', 'codex-harness-mapping']) {
    const entry = integrations.get(id);
    check(entry?.path === 'harness-core/README.md', `${id}.path must resolve to the thin pointer`, errors);
    check(entry?.docs === 'harness-core/README.md', `${id}.docs must resolve to the thin pointer`, errors);
    check(entry?.capability_record?.evidence?.evidence_ref === 'harness-core/CURRENT_RELEASE_EVIDENCE.json', `${id} must use the current release evidence`, errors);
  }
  check(manifest.discovery?.harness_core_canonical_repository === 'https://github.com/rhein1/agoragentic-harness-core', 'discovery is missing the standalone repository', errors);
  check(manifest.discovery?.harness_core_npm === 'https://www.npmjs.com/package/agoragentic-harness-core', 'discovery is missing the npm package', errors);
  check(manifest.discovery?.harness_core_release === `https://github.com/rhein1/agoragentic-harness-core/releases/tag/v${CURRENT_VERSION}`, `discovery is missing the v${CURRENT_VERSION} release`, errors);
  check(manifest.discovery?.harness_core_release_evidence === 'harness-core/CURRENT_RELEASE_EVIDENCE.json', 'discovery is missing current release evidence', errors);
  check(manifest.discovery?.harness_core_cutover_release === `https://github.com/rhein1/agoragentic-harness-core/releases/tag/v${CUTOVER_VERSION}`, 'discovery is missing the historical cutover release', errors);
  check(manifest.discovery?.harness_core_cutover_evidence === 'harness-core/STANDALONE_RELEASE_EVIDENCE.json', 'discovery is missing historical cutover evidence', errors);

  const ecosystem = readJson(path.join(root, 'ecosystem.json'));
  const product = ecosystem.products.find((entry) => entry.id === 'harness-core');
  check(product?.repository === 'https://github.com/rhein1/agoragentic-harness-core', 'ecosystem Harness Core product still points to the monorepo', errors);
  check(ecosystem.repositories.some((entry) => entry.url === 'https://github.com/rhein1/agoragentic-harness-core'), 'ecosystem repository inventory omits standalone Harness Core', errors);

  for (const consumer of ['gstack', 'opencode']) {
    const packageJson = readJson(path.join(root, consumer, 'package.json'));
    const lock = readJson(path.join(root, consumer, 'package-lock.json'));
    check(packageJson.dependencies?.['agoragentic-harness-core'] === CURRENT_VERSION, `${consumer} must pin agoragentic-harness-core ${CURRENT_VERSION}`, errors);
    check(lock.packages?.['']?.dependencies?.['agoragentic-harness-core'] === CURRENT_VERSION, `${consumer} lock root must pin ${CURRENT_VERSION}`, errors);
    check(lock.packages?.['node_modules/agoragentic-harness-core']?.version === CURRENT_VERSION, `${consumer} lock must resolve ${CURRENT_VERSION}`, errors);
  }

  for (const retired of [
    '.github/workflows/publish-harness-core.yml',
    '.github/workflows/harness-evaluation-adapters.yml',
    '.github/workflows/harness-core-extraction.yml',
    'scripts/prepare-harness-core-extraction.mjs',
    'scripts/verify-harness-core-extraction.mjs',
    'test/harness-core-extraction.test.mjs',
  ]) {
    check(!fs.existsSync(path.join(root, retired)), `retired monorepo surface still exists: ${retired}`, errors);
  }

  const gstackCompat = fs.readFileSync(path.join(root, 'gstack', 'scripts', 'test-harness-core-compat.mjs'), 'utf8');
  check(!gstackCompat.includes("'..', 'harness-core'"), 'gstack compatibility test still packs sibling monorepo source', errors);
  check(gstackCompat.includes(`expectedPublishedVersion = '${CURRENT_VERSION}'`), 'gstack compatibility test does not pin the current published exact version', errors);
  check(gstackCompat.includes('agoragentic-harness-core@${expectedPublishedVersion}'), 'gstack compatibility test does not install the pinned published package', errors);

  return { ok: errors.length === 0, errors };
}

function main() {
  const result = verifyHarnessCoreCutover();
  if (!result.ok) {
    for (const error of result.errors) console.error(`FAIL: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Harness Core cutover ${CUTOVER_VERSION} and current release ${CURRENT_VERSION} verified.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
