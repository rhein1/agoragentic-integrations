import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PRIME_AGENT_HOST_CONTRACT, PRIME_AGENT_HOST_IDENTITY } from './host-contract.mjs';
import { buildTreeIntegrity } from './artifact-integrity.mjs';

export const PRIME_AGENT_RELEASE = Object.freeze({
  repository: PRIME_AGENT_HOST_IDENTITY.repository,
  tag: PRIME_AGENT_HOST_IDENTITY.tag,
  version: PRIME_AGENT_HOST_IDENTITY.version,
  commit: PRIME_AGENT_HOST_IDENTITY.commit,
  asset_name: PRIME_AGENT_HOST_IDENTITY.release_asset,
  asset_url: 'https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.7.2/prime-agent-0.7.2.tgz',
  asset_size_bytes: 9387295,
  asset_sha256: PRIME_AGENT_HOST_IDENTITY.release_asset_sha256.slice('sha256:'.length),
});

const REQUIRED_PACKAGE_FILES = Object.freeze([
  'dist/bundle/cli.js',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/core/extensions/index.js',
  'docs/rpc.md',
  'docs/extensions.md',
]);

const EXACT_R2_DEPENDENCIES = Object.freeze({
  '@earendil-works/pi-agent-core': 'https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.7.2/prime-agent-core-0.7.2.tgz',
  '@earendil-works/pi-ai': 'https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.7.2/prime-agent-ai-0.7.2.tgz',
  '@earendil-works/pi-tui': 'https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.7.2/prime-agent-tui-0.7.2.tgz',
});

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function inside(root, candidate) {
  const rel = relative(realpathSync(root), realpathSync(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function validatePrimeAgentPackageMetadata(packageJson) {
  const blockers = [];
  const exact = (condition, blocker) => {
    if (!condition) blockers.push(blocker);
  };
  exact(packageJson?.name === 'prime-agent', 'package_name_mismatch');
  exact(packageJson?.version === PRIME_AGENT_RELEASE.version, 'package_version_mismatch');
  exact(packageJson?.type === 'module', 'package_type_mismatch');
  exact(packageJson?.engines?.node === '>=22.8.0', 'package_node_engine_mismatch');
  exact(packageJson?.bin?.['prime-agent'] === 'dist/bundle/cli.js', 'package_cli_entry_mismatch');
  exact(packageJson?.main === './dist/index.js', 'package_main_entry_mismatch');
  exact(packageJson?.exports?.['.']?.import === './dist/index.js', 'package_export_entry_mismatch');
  exact(packageJson?.exports?.['./hooks']?.import === './dist/core/hooks/index.js', 'package_hooks_export_mismatch');
  exact(packageJson?.piConfig?.name === 'prime-agent', 'package_pi_config_name_mismatch');
  exact(packageJson?.piConfig?.configDir === '.prime/agent', 'package_pi_config_dir_mismatch');
  exact(packageJson?.pi === undefined, 'host_package_must_not_claim_extension_manifest');
  for (const [name, expected] of Object.entries(EXACT_R2_DEPENDENCIES)) {
    exact(packageJson?.dependencies?.[name] === expected, `package_dependency_mismatch:${name}`);
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze(blockers) });
}

function extractVerifiedArchive(artifactPath) {
  const extractionRoot = mkdtempSync(join(tmpdir(), 'agoragentic-prime-agent-v072-'));
  execFileSync('tar', ['-xzf', artifactPath, '-C', extractionRoot], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return extractionRoot;
}

export function verifyPrimeAgentReleaseArtifact(artifactPath) {
  const blockers = [];
  const warnings = [];
  const resolvedArtifact = resolve(String(artifactPath || ''));
  let observedSize = null;
  let observedSha256 = null;
  let packageMetadata = null;
  let packageFilesVerified = false;
  let hooksExportTargetPresent = false;
  let firstPartyFileCount = 0;
  let firstPartyTreeDigest = null;
  let extractionRoot = null;

  try {
    const info = statSync(resolvedArtifact);
    if (!info.isFile()) blockers.push('release_artifact_not_regular_file');
    observedSize = info.size;
    observedSha256 = sha256File(resolvedArtifact);
  } catch {
    blockers.push('release_artifact_unreadable');
  }

  if (basename(resolvedArtifact) !== PRIME_AGENT_RELEASE.asset_name) blockers.push('release_artifact_name_mismatch');
  if (observedSize !== PRIME_AGENT_RELEASE.asset_size_bytes) blockers.push('release_artifact_size_mismatch');
  if (observedSha256 !== PRIME_AGENT_RELEASE.asset_sha256) blockers.push('release_artifact_sha256_mismatch');

  if (blockers.length === 0) {
    try {
      extractionRoot = extractVerifiedArchive(resolvedArtifact);
      const packageRoot = join(extractionRoot, 'package');
      const packagePath = join(packageRoot, 'package.json');
      if (!existsSync(packagePath) || !inside(extractionRoot, packagePath) || !lstatSync(packagePath).isFile()) {
        blockers.push('release_package_path_invalid');
      } else {
        packageMetadata = JSON.parse(readFileSync(packagePath, 'utf8'));
        blockers.push(...validatePrimeAgentPackageMetadata(packageMetadata).blockers);
        hooksExportTargetPresent = existsSync(join(packageRoot, 'dist', 'core', 'hooks', 'index.js'));
        if (!hooksExportTargetPresent) {
          warnings.push('published_hooks_export_target_missing');
        }
        for (const requiredPath of REQUIRED_PACKAGE_FILES) {
          const candidate = join(packageRoot, requiredPath);
          if (!existsSync(candidate) || !inside(packageRoot, candidate) || !lstatSync(candidate).isFile()) {
            blockers.push(`release_package_file_missing:${requiredPath}`);
          }
        }
        const firstPartyIntegrity = buildTreeIntegrity(packageRoot, {
          excludeTopLevel: ['node_modules', 'package-lock.json', 'npm-shrinkwrap.json'],
        });
        blockers.push(...firstPartyIntegrity.blockers.map((blocker) => `release_tree:${blocker}`));
        firstPartyFileCount = firstPartyIntegrity.file_count;
        firstPartyTreeDigest = firstPartyIntegrity.tree_digest;
        if (
          firstPartyFileCount !== PRIME_AGENT_HOST_CONTRACT.release_first_party_file_count
          || firstPartyTreeDigest !== PRIME_AGENT_HOST_CONTRACT.release_first_party_tree_digest
        ) {
          blockers.push('release_first_party_tree_mismatch');
        }
        packageFilesVerified = blockers.length === 0;
      }
    } catch (error) {
      blockers.push(`release_archive_invalid:${error.code || error.name || 'error'}`);
    } finally {
      if (extractionRoot) rmSync(extractionRoot, { recursive: true, force: true });
    }
  }

  return Object.freeze({
    schema: 'agoragentic.prime-agent.release-verification.v1',
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
    warnings: Object.freeze([...new Set(warnings)]),
    release: PRIME_AGENT_RELEASE,
    observed: Object.freeze({
      asset_name: basename(resolvedArtifact),
      asset_size_bytes: observedSize,
      asset_sha256: observedSha256,
      package_name: packageMetadata?.name || null,
      package_version: packageMetadata?.version || null,
      node_engine: packageMetadata?.engines?.node || null,
      package_files_verified: packageFilesVerified,
      hooks_export_target_present: hooksExportTargetPresent,
      first_party_file_count: firstPartyFileCount,
      first_party_tree_digest: firstPartyTreeDigest,
    }),
    immutable_release_pin_verified: blockers.length === 0,
    exact_host_artifact_loaded: false,
    runtime_verified: false,
    runtime_executed: false,
    exact_runtime_verified: false,
    hosted_available: false,
    production_activated: false,
    credentials_used: false,
    paid_provider_calls: false,
    authority_granted: false,
    package_published: false,
  });
}

function artifactArgument(argv) {
  const index = argv.indexOf('--artifact');
  if (index !== -1 && argv[index + 1]) return argv[index + 1];
  return process.env.PRIME_AGENT_V072_TGZ || null;
}

function main() {
  const artifactPath = artifactArgument(process.argv.slice(2));
  if (!artifactPath) {
    console.error('Usage: node release-verifier.mjs --artifact <prime-agent-0.7.2.tgz>');
    process.exitCode = 2;
    return;
  }
  const result = verifyPrimeAgentReleaseArtifact(artifactPath);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
