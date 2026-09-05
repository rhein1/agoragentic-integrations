#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  RISK_FORK_CLIENT_GATE_MAX_GATEWAY_BYTES,
  RISK_FORK_CLIENTS,
  createRiskForkClientAdoptionPacket,
} from '../src/client-adoption.mjs';
import { containsSecretShapedText } from '../src/util.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.dirname(packageRoot);
const gateEntrypoint = path.join(packageRoot, 'clients', 'one-tool-stdio-gate.mjs');
const sourceCheckoutGatewayEntrypoint = path.join(repositoryRoot, 'mcp', 'risk-forkd.js');
const FILE_STABILITY_WINDOW_MS = 5;

function usage() {
  return [
    'Usage:',
    '  client-adoption.mjs status',
    '  client-adoption.mjs plan --client <all|claude-code|codex|cursor> [--gateway <absolute risk-forkd.js>]',
    '  client-adoption.mjs write-review --client <...> --output <new-absolute-directory> [--gateway <absolute risk-forkd.js>] --yes',
    '  client-adoption.mjs verify-review --manifest <absolute-manifest.json> [--gateway <absolute risk-forkd.js>]',
  ].join('\n');
}

function parseFlags(values) {
  const flags = {};
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === '--yes') {
      if (flags.yes !== undefined) throw new TypeError('Duplicate --yes');
      flags.yes = true;
      continue;
    }
    const takesValue = flag === '--client'
      || flag === '--gateway'
      || flag === '--manifest'
      || flag === '--output';
    if (!takesValue || index + 1 >= values.length) {
      throw new TypeError(`Unknown or incomplete flag: ${flag}`);
    }
    const key = flag.slice(2);
    if (flags[key] !== undefined) throw new TypeError(`Duplicate ${flag}`);
    flags[key] = values[index + 1];
    index += 1;
  }
  return flags;
}

async function exactRegularFile(filename, field, { requireCanonical = false } = {}) {
  if (requireCanonical && await realpath(filename) !== filename) {
    throw new TypeError(`${field} must use its exact canonical path`);
  }
  const pathDetails = await lstat(filename, { bigint: true });
  if (!pathDetails.isFile() || pathDetails.isSymbolicLink()) {
    throw new TypeError(`${field} must be a regular non-symbolic file of at most ${RISK_FORK_CLIENT_GATE_MAX_GATEWAY_BYTES} bytes`);
  }
  const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
  const nonBlock = Number.isInteger(fsConstants.O_NONBLOCK) ? fsConstants.O_NONBLOCK : 0;
  const handle = await open(filename, fsConstants.O_RDONLY | noFollow | nonBlock);
  try {
    const details = await handle.stat({ bigint: true });
    if (!details.isFile()
      || details.size < 1n
      || details.size > BigInt(RISK_FORK_CLIENT_GATE_MAX_GATEWAY_BYTES)
      || details.dev !== pathDetails.dev
      || details.ino !== pathDetails.ino) {
      throw new TypeError(`${field} must be the same regular non-symbolic file of at most ${RISK_FORK_CLIENT_GATE_MAX_GATEWAY_BYTES} bytes`);
    }
    const expectedSize = Number(details.size);
    async function readSnapshot() {
      const bytes = Buffer.alloc(expectedSize);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead === 0) {
          throw new TypeError(`${field} changed while its exact bytes were being read`);
        }
        offset += result.bytesRead;
      }
      const extra = Buffer.alloc(1);
      const extraRead = await handle.read(extra, 0, 1, expectedSize);
      if (extraRead.bytesRead !== 0) {
        throw new TypeError(`${field} changed while its exact bytes were being read`);
      }
      return bytes;
    }

    function sameSnapshot(left, right) {
      return left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode
        && left.nlink === right.nlink
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
    }

    const first = await readSnapshot();
    const middle = await handle.stat({ bigint: true });
    await new Promise((resolve) => setTimeout(resolve, FILE_STABILITY_WINDOW_MS));
    const second = await readSnapshot();
    const after = await handle.stat({ bigint: true });
    const finalPathDetails = await lstat(filename, { bigint: true });
    if (!sameSnapshot(details, middle)
      || !sameSnapshot(middle, after)
      || !first.equals(second)
      || !finalPathDetails.isFile()
      || finalPathDetails.isSymbolicLink()
      || !sameSnapshot(after, finalPathDetails)
      || (requireCanonical && await realpath(filename) !== filename)) {
      throw new TypeError(`${field} changed while its exact bytes were being read`);
    }
    return first;
  } finally {
    await handle.close();
  }
}

function sha256Ref(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function packetFor(client, gatewayEntrypoint = sourceCheckoutGatewayEntrypoint) {
  const normalizedGateEntrypoint = assertAbsolute(gateEntrypoint, 'client gate');
  const normalizedGatewayEntrypoint = assertAbsolute(gatewayEntrypoint, 'risk-forkd gateway');
  const normalizedNodeExecutable = assertAbsolute(process.execPath, 'Node executable');
  const [gateBytes, gatewayBytes] = await Promise.all([
    exactRegularFile(normalizedGateEntrypoint, 'client gate'),
    exactRegularFile(normalizedGatewayEntrypoint, 'risk-forkd gateway', { requireCanonical: true }),
  ]);
  return createRiskForkClientAdoptionPacket({
    client,
    gateEntrypoint: normalizedGateEntrypoint,
    gateSha256: sha256Ref(gateBytes),
    gatewayEntrypoint: normalizedGatewayEntrypoint,
    gatewaySha256: sha256Ref(gatewayBytes),
    nodeExecutable: normalizedNodeExecutable,
  });
}

function assertGateway(value) {
  if (value === undefined) return sourceCheckoutGatewayEntrypoint;
  const entrypoint = assertAbsolute(value, '--gateway');
  if (path.basename(entrypoint) !== 'risk-forkd.js') {
    throw new TypeError('--gateway must end in risk-forkd.js');
  }
  return entrypoint;
}

function assertClient(value) {
  const supported = value === 'claude-code' || value === 'codex' || value === 'cursor';
  if (value !== 'all' && !supported) {
    throw new TypeError(`--client must be one of: all, ${RISK_FORK_CLIENTS.join(', ')}`);
  }
  return value;
}

function assertAbsolute(value, field) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${field} must be an absolute path`);
  }
  const normalized = path.normalize(value);
  if (containsSecretShapedText(normalized)) {
    throw new TypeError(`${field} must not contain credential-shaped material`);
  }
  return normalized;
}

async function writeReview(packet, output) {
  try {
    await lstat(output);
    throw new TypeError('--output must identify a new directory');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const parent = path.dirname(output);
  const parentDetails = await lstat(parent);
  if (!parentDetails.isDirectory() || parentDetails.isSymbolicLink()) {
    throw new TypeError('--output parent must be a regular directory');
  }
  await mkdir(output, { mode: 0o700 });

  const writtenFiles = [];
  for (const entry of packet.outputs) {
    const target = path.join(output, entry.review_filename);
    await writeFile(target, entry.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    writtenFiles.push({
      client: entry.client,
      filename: entry.review_filename,
      sha256: sha256Ref(Buffer.from(entry.content, 'utf8')),
    });
  }
  const manifest = {
    schema: 'agoragentic.risk-fork.client-adoption-review-manifest.v1',
    status: packet.status,
    client: packet.client,
    expected_tool_inventory: packet.expected_tool_inventory,
    gateway: packet.gateway,
    files: writtenFiles,
    controls: {
      ...packet.controls,
      writes_performed: true,
      review_packet_written: true,
      active_client_paths_written: false,
    },
  };
  const manifestPath = path.join(output, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return { manifest, manifest_path: manifestPath };
}

async function verifyReview(manifestPath, gatewayEntrypoint) {
  const manifestBytes = await exactRegularFile(manifestPath, 'manifest');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest?.schema !== 'agoragentic.risk-fork.client-adoption-review-manifest.v1'
    || manifest?.status !== 'source_only_default_off'
    || typeof manifest.client !== 'string'
    || !Array.isArray(manifest.expected_tool_inventory)
    || manifest.expected_tool_inventory.length !== 1
    || manifest.expected_tool_inventory[0] !== 'risk_fork_protect'
    || !Array.isArray(manifest.files)
    || manifest.files.length < 1
    || manifest.controls?.active_client_paths_written !== false
    || manifest.controls?.client_enabled !== false
    || manifest.controls?.provider_calls !== 0
    || manifest.controls?.network_used !== false
    || manifest.controls?.live_traffic_protected !== false) {
    throw new TypeError('Review manifest failed the closed source-only contract');
  }
  const packet = await packetFor(assertClient(manifest.client), gatewayEntrypoint);
  const root = path.dirname(manifestPath);
  const expectedFiles = packet.outputs.map((entry) => ({
    client: entry.client,
    filename: entry.review_filename,
    sha256: sha256Ref(Buffer.from(entry.content, 'utf8')),
  }));
  const expectedManifest = {
    schema: 'agoragentic.risk-fork.client-adoption-review-manifest.v1',
    status: packet.status,
    client: packet.client,
    expected_tool_inventory: packet.expected_tool_inventory,
    gateway: packet.gateway,
    files: expectedFiles,
    controls: {
      ...packet.controls,
      writes_performed: true,
      review_packet_written: true,
      active_client_paths_written: false,
    },
  };
  if (!isDeepStrictEqual(manifest, expectedManifest)) {
    throw new TypeError('Review manifest does not match the exact current source packet');
  }

  const expectedNames = [...expectedFiles.map((entry) => entry.filename), 'manifest.json'].sort();
  const actualNames = (await readdir(root)).sort();
  if (!isDeepStrictEqual(actualNames, expectedNames)) {
    throw new TypeError('Review directory contains a missing or unexpected entry');
  }
  for (const output of packet.outputs) {
    const bytes = await exactRegularFile(path.join(root, output.review_filename), output.review_filename);
    if (!bytes.equals(Buffer.from(output.content, 'utf8'))) {
      throw new TypeError(`Review file does not match current source: ${output.review_filename}`);
    }
  }
  return {
    schema: 'agoragentic.risk-fork.client-adoption-review-verification.v1',
    status: 'passed',
    files_verified: expectedFiles.length,
    active_client_paths_written: false,
    client_enabled: false,
    provider_calls: 0,
    network_used: false,
    live_traffic_protected: false,
  };
}

try {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (command === 'status' && Object.keys(flags).length === 0) {
    process.stdout.write(`${JSON.stringify({
      schema: 'agoragentic.risk-fork.client-adoption-status.v1',
      status: 'source_only_default_off',
      supported_clients: RISK_FORK_CLIENTS,
      gateway_standalone_startup: 'refused',
      activation_supported: false,
      client_enabled: false,
      provider_calls: 0,
      network_used: false,
      live_traffic_protected: false,
    })}\n`);
  } else if (command === 'plan'
    && flags.client
    && flags.output === undefined
    && flags.manifest === undefined
    && flags.yes === undefined) {
    process.stdout.write(`${JSON.stringify(
      await packetFor(assertClient(flags.client), assertGateway(flags.gateway)),
      null,
      2,
    )}\n`);
  } else if (command === 'write-review'
    && flags.client
    && flags.output
    && flags.yes === true
    && flags.manifest === undefined) {
    const packet = await packetFor(assertClient(flags.client), assertGateway(flags.gateway));
    process.stdout.write(`${JSON.stringify(
      await writeReview(packet, assertAbsolute(flags.output, '--output')),
      null,
      2,
    )}\n`);
  } else if (command === 'verify-review'
    && flags.manifest
    && flags.client === undefined
    && flags.output === undefined
    && flags.yes === undefined) {
    process.stdout.write(`${JSON.stringify(
      await verifyReview(
        assertAbsolute(flags.manifest, '--manifest'),
        assertGateway(flags.gateway),
      ),
      null,
      2,
    )}\n`);
  } else {
    throw new TypeError(usage());
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    schema: 'agoragentic.risk-fork.client-adoption-error.v1',
    status: 'refused',
    message: error instanceof Error ? error.message : String(error),
    client_enabled: false,
    provider_calls: 0,
    network_used: false,
    live_traffic_protected: false,
  })}\n`);
  process.exitCode = 64;
}
