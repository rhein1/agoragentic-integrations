import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repositoryRoot = path.resolve(packageRoot, '..');
const verifySources = process.argv.slice(2).includes('--source');
const quiet = process.argv.slice(2).includes('--quiet');
const reviewedSourceCommit = '27f1c9f90b087a4c98bf537a8201c5443885eb72';

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function resolveBelow(base, relative, label) {
  if (typeof relative !== 'string' || relative === '' || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a relative path`);
  }
  const resolved = path.resolve(base, ...relative.split('/'));
  const back = path.relative(base, resolved);
  if (back === '' || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    throw new Error(`${label} escapes its verification root`);
  }
  return resolved;
}

async function verifyFile(base, record, label) {
  const bytes = await readFile(resolveBelow(base, record.path, label));
  if (bytes.byteLength !== record.bytes || sha256(bytes) !== record.sha256) {
    throw new Error(`${label} integrity mismatch: ${record.path}`);
  }
}

const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(packageRoot, 'integrity-manifest.json'), 'utf8'));
if (manifest.schema !== 'agoragentic.risk-fork-hosted-mcp.integrity.v1'
  || manifest.package?.name !== '@agoragentic/risk-fork-hosted-mcp'
  || manifest.package?.version !== '0.1.0-alpha.0'
  || manifest.package?.private !== true
  || manifest.source_commit !== reviewedSourceCommit
  || !Array.isArray(manifest.runtime_dependencies)
  || manifest.runtime_dependencies.length !== 0
  || !Array.isArray(manifest.exports)
  || !Array.isArray(manifest.inputs)
  || !Array.isArray(manifest.packaged_assets)
  || manifest.third_party_notices?.path !== 'THIRD_PARTY_NOTICES.txt'
  || !Number.isSafeInteger(manifest.third_party_notices?.bytes)
  || !/^sha256:[a-f0-9]{64}$/.test(manifest.third_party_notices?.sha256 ?? '')
  || !Array.isArray(manifest.third_party_notices?.sources)
  || JSON.stringify(manifest.optional_peer_dependencies) !== JSON.stringify([
    { name: 'e2b', version: '2.39.0', optional: true },
  ])) {
  throw new Error('Hosted MCP integrity manifest contract is invalid');
}
if (packageJson.name !== '@agoragentic/risk-fork-hosted-mcp'
  || packageJson.version !== '0.1.0-alpha.0'
  || packageJson.private !== true
  || packageJson.dependencies !== undefined
  || packageJson.optionalDependencies !== undefined
  || JSON.stringify(packageJson.peerDependencies) !== JSON.stringify({ e2b: '2.39.0' })
  || JSON.stringify(packageJson.peerDependenciesMeta) !== JSON.stringify({ e2b: { optional: true } })
  || !/PUBLISH_DISABLED/.test(packageJson.scripts?.prepublishOnly ?? '')) {
  throw new Error('Hosted MCP package authority/dependency contract is invalid');
}
const allowedExternalImports = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  'e2b',
]);
if (!Array.isArray(manifest.build?.external_imports)
  || !manifest.build.external_imports.includes('e2b')
  || manifest.build.external_imports.some((specifier) => !allowedExternalImports.has(specifier))) {
  throw new Error('Hosted MCP bundle contains an unapproved external import');
}

await verifyFile(packageRoot, manifest.artifact, 'artifact');
for (const asset of manifest.packaged_assets ?? []) {
  await verifyFile(packageRoot, asset, 'packaged asset');
  if (asset.source_path !== undefined) {
    const input = manifest.inputs?.find((record) => record.path === asset.source_path);
    if (!input
      || input.source !== 'git_blob'
      || input.bytes !== asset.bytes
      || input.sha256 !== asset.sha256) {
      throw new Error(`Packaged asset is not bound to a reviewed Git source: ${asset.path}`);
    }
  }
}
const noticeAsset = manifest.packaged_assets.find(
  (asset) => asset.path === manifest.third_party_notices.path,
);
if (!noticeAsset
  || noticeAsset.bytes !== manifest.third_party_notices.bytes
  || noticeAsset.sha256 !== manifest.third_party_notices.sha256) {
  throw new Error('Third-party notices are not bound to the packaged asset');
}
const noticeSources = manifest.third_party_notices.sources;
if (JSON.stringify(noticeSources) !== JSON.stringify(
  [...noticeSources].sort((left, right) => left.package.localeCompare(right.package)),
)) {
  throw new Error('Third-party notice sources are not deterministically ordered');
}
const noticesText = (await readFile(
  resolveBelow(packageRoot, manifest.third_party_notices.path, 'third-party notices'),
)).toString('utf8');
const noticeBlocks = noticesText.split(`${'='.repeat(72)}\n`).slice(1).map((block) => block.trim());
if (noticeBlocks.length !== noticeSources.length) {
  throw new Error('Third-party notice source count does not match the generated notice blocks');
}
for (let index = 0; index < noticeSources.length; index += 1) {
  const source = noticeSources[index];
  if (typeof source.package !== 'string' || source.package === ''
    || typeof source.version !== 'string' || source.version === ''
    || typeof source.declared_license !== 'string' || source.declared_license === ''
    || !/^(?:standalone_license_file|markdown_license_section)$/.test(source.method ?? '')
    || typeof source.path !== 'string' || source.path === ''
    || !Number.isSafeInteger(source.source_bytes) || source.source_bytes <= 0
    || !/^sha256:[a-f0-9]{64}$/.test(source.source_sha256 ?? '')
    || !Number.isSafeInteger(source.notice_bytes) || source.notice_bytes <= 0
    || !/^sha256:[a-f0-9]{64}$/.test(source.notice_sha256 ?? '')) {
    throw new Error(`Third-party notice source contract is invalid at index ${index}`);
  }
  const input = manifest.inputs.find((entry) => entry.path === source.path);
  if (!input
    || input.source !== 'workspace_dependency'
    || input.bytes !== source.source_bytes
    || input.sha256 !== source.source_sha256) {
    throw new Error(`Third-party notice source is not bound to an exact workspace input: ${source.path}`);
  }
  const prefix = [
    `${source.package}@${source.version}`,
    `Declared license: ${source.declared_license}`,
    `Notice source: ${source.path}`,
    `Notice source method: ${source.method}`,
    `Notice source bytes: ${source.source_bytes}`,
    `Notice source SHA-256: ${source.source_sha256}`,
    `Extracted notice bytes: ${source.notice_bytes}`,
    `Extracted notice SHA-256: ${source.notice_sha256}`,
    '',
  ].join('\n');
  const block = noticeBlocks[index];
  if (!block.startsWith(prefix)) {
    throw new Error(`Third-party notice metadata does not match its generated block: ${source.package}`);
  }
  const noticeBytes = Buffer.from(block.slice(prefix.length).trim(), 'utf8');
  if (noticeBytes.byteLength !== source.notice_bytes || sha256(noticeBytes) !== source.notice_sha256) {
    throw new Error(`Third-party extracted notice integrity mismatch: ${source.package}`);
  }
}
if (verifySources) {
  if (manifest.source_commit !== reviewedSourceCommit) throw new Error('Source commit is invalid');
  for (const input of manifest.inputs ?? []) {
    if (input.source === 'git_blob') {
      const bytes = execFileSync('git', ['show', `${manifest.source_commit}:${input.path}`], {
        cwd: repositoryRoot,
        encoding: 'buffer',
        maxBuffer: 32 * 1024 * 1024,
      });
      if (bytes.byteLength !== input.bytes || sha256(bytes) !== input.sha256) {
        throw new Error(`Git source input integrity mismatch: ${input.path}`);
      }
    } else if (input.source === 'package_source' || input.source === 'workspace_dependency') {
      await verifyFile(repositoryRoot, input, 'source input');
    } else {
      throw new Error(`Unsupported integrity input source: ${String(input.source)}`);
    }
  }
}

const bundle = await readFile(resolveBelow(packageRoot, manifest.artifact.path, 'artifact'));
const text = bundle.toString('utf8');
if (/\.\.\/mcp|\.\.\/risk-fork/.test(text) || /C:\\projects\\|C:\/projects\//i.test(text)) {
  throw new Error('Bundle contains a cross-worktree runtime reference');
}
const api = await import(`${pathToFileURL(resolveBelow(packageRoot, manifest.artifact.path, 'artifact')).href}?sha=${manifest.artifact.sha256.slice(7)}`);
if (JSON.stringify(Object.keys(api).sort()) !== JSON.stringify([...manifest.exports].sort())) {
  throw new Error('Bundle runtime exports do not match the integrity manifest');
}
if (api.HOSTED_MCP_BUNDLE_METADATA?.reviewed_source_commit !== reviewedSourceCommit
  || api.HOSTED_MCP_BUNDLE_METADATA?.authority_granted !== false
  || api.HOSTED_MCP_BUNDLE_METADATA?.outbound_mcp_transport_qualified !== false
  || api.HOSTED_MCP_BUNDLE_METADATA?.managed_postgres_qualified !== false
  || api.HOSTED_MCP_BUNDLE_METADATA?.e2b_live_qualified !== false) {
  throw new Error('Bundle runtime metadata does not preserve reviewed default-off authority state');
}
if (!quiet) process.stdout.write(`RISK_FORK_HOSTED_MCP_INTEGRITY_OK ${manifest.artifact.sha256}\n`);
