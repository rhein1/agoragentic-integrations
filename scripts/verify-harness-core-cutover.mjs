#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EXPECTED_VERSION = '0.3.1';
export const EXPECTED_POINTER_FILES = [
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
    'releases/tag/v0.3.1',
    'thin pointer',
  ]) {
    check(readme.includes(required), `harness-core/README.md is missing ${required}`, errors);
  }
  check(/not\s+settlement receipts/.test(readme), 'harness-core/README.md is missing the settlement-receipt boundary', errors);

  const evidence = readJson(path.join(pointerRoot, 'STANDALONE_RELEASE_EVIDENCE.json'));
  check(evidence.schema === 'agoragentic.harness-core.standalone-release-evidence.v1', 'unexpected cutover evidence schema', errors);
  check(evidence.canonical_repository === 'https://github.com/rhein1/agoragentic-harness-core', 'canonical Harness Core repository is not standalone', errors);
  check(evidence.source_cutover?.duplicate_canonical_implementation_removed === true, 'duplicate canonical implementation is not recorded as removed', errors);
  check(evidence.release?.tag === `v${EXPECTED_VERSION}`, `release evidence must target v${EXPECTED_VERSION}`, errors);
  check(evidence.release?.target_commit === 'be6ecc806c87d332434efa265d0c44efe432028a', 'release evidence target commit changed', errors);
  check(evidence.npm?.version === EXPECTED_VERSION, `npm evidence must target ${EXPECTED_VERSION}`, errors);
  check(evidence.npm?.provenance_predicate === 'https://slsa.dev/provenance/v1', 'SLSA provenance evidence is missing', errors);
  check(evidence.publishing?.trusted_publisher_repository === 'rhein1/agoragentic-harness-core', 'trusted publisher still points at the monorepo', errors);
  check(evidence.publishing?.trusted_publisher_workflow === 'publish.yml', 'trusted publisher workflow must be publish.yml', errors);
  check(evidence.publishing?.conclusion === 'success', 'standalone publish workflow is not recorded as successful', errors);
  check(evidence.clean_room?.result === 'passed', 'clean-room published-package verification is not recorded as passed', errors);
  check(Object.values(evidence.authority || {}).every((value) => value === false), 'cutover evidence grants authority', errors);

  const manifest = readJson(path.join(root, 'integrations.json'));
  const integrations = new Map(manifest.integrations.map((entry) => [entry.id, entry]));
  for (const id of ['harness-core', 'codex-harness-mapping']) {
    const entry = integrations.get(id);
    check(entry?.path === 'harness-core/README.md', `${id}.path must resolve to the thin pointer`, errors);
    check(entry?.docs === 'harness-core/README.md', `${id}.docs must resolve to the thin pointer`, errors);
    check(entry?.capability_record?.evidence?.evidence_ref === 'harness-core/STANDALONE_RELEASE_EVIDENCE.json', `${id} must use the standalone release evidence`, errors);
  }
  check(manifest.discovery?.harness_core_canonical_repository === 'https://github.com/rhein1/agoragentic-harness-core', 'discovery is missing the standalone repository', errors);
  check(manifest.discovery?.harness_core_npm === 'https://www.npmjs.com/package/agoragentic-harness-core', 'discovery is missing the npm package', errors);
  check(manifest.discovery?.harness_core_release === 'https://github.com/rhein1/agoragentic-harness-core/releases/tag/v0.3.1', 'discovery is missing the v0.3.1 release', errors);

  const ecosystem = readJson(path.join(root, 'ecosystem.json'));
  const product = ecosystem.products.find((entry) => entry.id === 'harness-core');
  check(product?.repository === 'https://github.com/rhein1/agoragentic-harness-core', 'ecosystem Harness Core product still points to the monorepo', errors);
  check(ecosystem.repositories.some((entry) => entry.url === 'https://github.com/rhein1/agoragentic-harness-core'), 'ecosystem repository inventory omits standalone Harness Core', errors);

  for (const consumer of ['gstack', 'opencode']) {
    const packageJson = readJson(path.join(root, consumer, 'package.json'));
    const lock = readJson(path.join(root, consumer, 'package-lock.json'));
    check(packageJson.dependencies?.['agoragentic-harness-core'] === EXPECTED_VERSION, `${consumer} must pin agoragentic-harness-core ${EXPECTED_VERSION}`, errors);
    check(lock.packages?.['']?.dependencies?.['agoragentic-harness-core'] === EXPECTED_VERSION, `${consumer} lock root must pin ${EXPECTED_VERSION}`, errors);
    check(lock.packages?.['node_modules/agoragentic-harness-core']?.version === EXPECTED_VERSION, `${consumer} lock must resolve ${EXPECTED_VERSION}`, errors);
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
  check(gstackCompat.includes(`expectedPublishedVersion = '${EXPECTED_VERSION}'`), 'gstack compatibility test does not pin the published exact version', errors);
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
  console.log(`Harness Core standalone cutover verified at ${EXPECTED_VERSION}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
