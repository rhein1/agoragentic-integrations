#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { extractAndVerifyOfflineKit } from '../src/offline-kit.mjs';
import { runMcpClientConformance } from './mcp-client-conformance.mjs';
import {
  verifyReleaseArtifactSet,
  verifyReleaseSbomAgainstKit,
} from './release-artifacts.mjs';

const execFileAsync = promisify(execFile);

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index === process.argv.length - 1) return null;
  return process.argv[index + 1];
}

const artifactDirectory = option('--artifacts');
const extractionDirectory = option('--extract-to');
const recordPath = option('--record');
if (!artifactDirectory || !path.isAbsolute(artifactDirectory)) {
  throw new Error('--artifacts requires an explicit absolute directory');
}
if (!extractionDirectory || !path.isAbsolute(extractionDirectory)) {
  throw new Error('--extract-to requires an explicit absolute destination');
}
if (recordPath && !path.isAbsolute(recordPath)) {
  throw new Error('--record must be an explicit absolute filename');
}

const artifact = await verifyReleaseArtifactSet({ artifactDirectory });
await mkdir(path.dirname(extractionDirectory), { recursive: true });
const extraction = await extractAndVerifyOfflineKit({
  zipPath: artifact.zip_path,
  destination: extractionDirectory,
});
if (extraction.verification.source_commit !== artifact.source_commit) {
  throw new Error('Fresh extraction source commit does not match the release envelope');
}
if (extraction.verification.manifest_sha256 !== artifact.internal_manifest_sha256
  || extraction.verification.manifest_bytes !== artifact.internal_manifest_bytes) {
  throw new Error('Fresh extraction manifest does not match the external release envelope');
}
const sbomVerification = await verifyReleaseSbomAgainstKit({
  sbomPath: artifact.sbom_path,
  kitDirectory: extractionDirectory,
  sourceCommit: artifact.source_commit,
  zipSha256: artifact.zip_sha256,
});
const entrypoint = path.join(
  extractionDirectory,
  'risk-fork',
  'hackathon',
  'bin',
  'risk-fork-demo.mjs',
);
const environment = Object.fromEntries(Object.entries({
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.WINDIR,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  TMPDIR: process.env.TMPDIR,
  AGORAGENTIC_NO_SPEND: '1',
  AGORAGENTIC_ALLOW_REAL_SPEND: '0',
  AGORAGENTIC_ALLOW_NETWORK_CANARIES: '0',
  RISK_FORK_DEMO_ALLOW_LOOPBACK: '0',
}).filter(([, value]) => typeof value === 'string' && value.length > 0));
const { stdout, stderr } = await execFileAsync(process.execPath, [entrypoint, 'verify-offline-kit'], {
  cwd: extractionDirectory,
  env: environment,
  windowsHide: true,
  timeout: 120_000,
  maxBuffer: 8 * 1024 * 1024,
});
if (stderr !== '') throw new Error('Fresh-kit verification emitted stderr');
const offlineVerification = JSON.parse(stdout);
if (offlineVerification.verified !== true
  || offlineVerification.source_commit !== artifact.source_commit
  || offlineVerification.provider_calls !== 0
  || offlineVerification.network_used !== false) {
  throw new Error('Fresh-kit runtime verification failed its truth boundary');
}
const mcp = await runMcpClientConformance({ entrypoint });
const record = {
  schema: 'agoragentic.risk-fork.client-verification-record.v1',
  recorded_at: new Date().toISOString(),
  source_commit: artifact.source_commit,
  zip_sha256: artifact.zip_sha256,
  platform: process.platform,
  architecture: process.arch,
  node_version: process.version,
  client: {
    name: 'minimal_protocol_conformance_probe',
    version: '1',
    transport: 'stdio_json_rpc',
    status: 'verified',
  },
  configuration: {
    source: 'not_configured',
    destination_ref: 'not_applicable',
    user_approved_mutation: false,
    credentials_included: false,
  },
  assertions: {
    initialize: 'verified',
    four_tool_inventory: 'verified',
    plan: 'verified',
    run: 'verified',
    receipt: 'verified',
    cleanup: 'verified',
  },
  gui_clients: {
    codex: 'unknown_not_tested',
    claude_desktop: 'unknown_not_tested',
    cursor: 'unknown_not_tested',
  },
  provider_calls: 0,
  network_used: false,
  live_traffic_protected: false,
  absolute_paths_included: false,
  notes: 'Automated minimal MCP stdio protocol probe; this is not GUI-client verification.',
  artifact: {
    verified: artifact.verified,
    build_manifest_sha256: artifact.build_manifest_sha256,
    sbom_sha256: artifact.sbom_sha256,
    sbom_content_verified: sbomVerification.verified,
    sbom_package_count: sbomVerification.package_count,
    checksum_sha256: artifact.checksum_sha256,
  },
  extraction: {
    verified: extraction.verification.verified,
    source_commit: extraction.verification.source_commit,
  },
  runtime: {
    verified: offlineVerification.verified,
    cleanup: offlineVerification.runtime?.cleanup ?? null,
  },
  mcp,
};
if (recordPath) {
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
}
process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
