import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  RISK_FORK_CLIENT_GATE_MAX_GATEWAY_BYTES,
  RISK_FORK_CLIENTS,
  RISK_FORK_GATEWAY_TOOL,
  createRiskForkClientAdoptionPacket,
  isRiskForkClientAdoptionPacket,
  verifyRiskForkClientAdoptionPacket,
} from '../src/client-adoption.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = path.dirname(packageRoot);
const gateEntrypoint = path.join(packageRoot, 'clients', 'one-tool-stdio-gate.mjs');
const gatewayEntrypoint = path.join(repositoryRoot, 'mcp', 'risk-forkd.js');
const cliEntrypoint = path.join(packageRoot, 'scripts', 'client-adoption.mjs');

function hashBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function hashFile(filename) {
  return hashBytes(await readFile(filename));
}

async function createPacket(client = 'all') {
  return createRiskForkClientAdoptionPacket({
    client,
    gateEntrypoint,
    gateSha256: await hashFile(gateEntrypoint),
    gatewayEntrypoint,
    gatewaySha256: await hashFile(gatewayEntrypoint),
    nodeExecutable: process.execPath,
  });
}

function runCli(args) {
  return spawnSync(process.execPath, [cliEntrypoint, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
}

test('client adoption packet passes its structural schema and deterministic verifier', async () => {
  const packet = await createPacket();
  const schema = JSON.parse(await readFile(
    path.join(packageRoot, 'schema', 'client-adoption-packet.v1.json'),
    'utf8',
  ));
  assert.equal(
    schema.$id,
    'https://agoragentic.com/schema/risk-fork-client-adoption-packet.v1.json',
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  assert.equal(validate(packet), true, JSON.stringify(validate.errors));
  assert.equal(verifyRiskForkClientAdoptionPacket(packet), true);
  assert.equal(isRiskForkClientAdoptionPacket(packet), true);
  assert.equal(
    verifyRiskForkClientAdoptionPacket(JSON.parse(JSON.stringify(packet))),
    true,
  );
  assert.equal(isRiskForkClientAdoptionPacket(JSON.parse(JSON.stringify(packet))), false);
  assert.equal(Object.isFrozen(packet), true);
  assert.deepEqual(packet.expected_tool_inventory, [RISK_FORK_GATEWAY_TOOL]);
  assert.equal(packet.gateway.runtime_closure_bound, false);
  assert.equal(packet.gateway.tool_input_schema_owner, 'future_risk-forkd_gateway');
  assert.equal(packet.gateway.tool_input_schema_bound, false);
  assert.deepEqual(packet.controls, {
    writes_performed: false,
    client_configuration_modified: false,
    client_enabled: false,
    activation_supported: false,
    provider_authority_granted: false,
    executor_bound: false,
    hosted_authority_granted: false,
    production_authority_granted: false,
    live_traffic_protected: false,
    credentials_included: false,
    provider_calls: 0,
    network_used: false,
  });
  assert.deepEqual(RISK_FORK_CLIENTS, ['claude-code', 'codex', 'cursor']);
});

test('client adoption schema rejects obvious inventory, activation, and posture contradictions', async () => {
  const schema = JSON.parse(await readFile(
    path.join(packageRoot, 'schema', 'client-adoption-packet.v1.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const packet = await createPacket();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const rejectedBySchema = (candidate) => {
    assert.equal(validate(candidate), false, 'structural guardrail must reject contradiction');
  };

  const activeContent = clone(packet);
  const activeCodex = activeContent.outputs.find((entry) => entry.client === 'codex');
  activeCodex.content = activeCodex.content.replace('enabled = false', 'enabled = true');
  rejectedBySchema(activeContent);

  const clientOutputMismatch = clone(packet);
  clientOutputMismatch.client = 'codex';
  rejectedBySchema(clientOutputMismatch);

  const duplicateOutput = clone(packet);
  duplicateOutput.outputs[1] = clone(duplicateOutput.outputs[0]);
  rejectedBySchema(duplicateOutput);

  const missingOutput = clone(packet);
  missingOutput.outputs.pop();
  rejectedBySchema(missingOutput);

  const extraOutput = clone(packet);
  extraOutput.outputs.push(clone(extraOutput.outputs[0]));
  rejectedBySchema(extraOutput);

  const contradictoryPosture = clone(packet);
  contradictoryPosture.outputs.find((entry) => entry.client === 'codex').native_default_off = false;
  rejectedBySchema(contradictoryPosture);
});

test('deterministic verification binds every selected client to its canonical outputs', async () => {
  const expected = new Map([
    ['all', [
      'claude-code-risk-fork.disabled.mcp.json',
      'claude-code-risk-fork.disabled.settings.json',
      'codex-risk-fork.disabled.toml',
      'cursor-risk-fork.disabled.mcp.json',
      'cursor-risk-fork.disabled.permissions.json',
    ]],
    ['claude-code', [
      'claude-code-risk-fork.disabled.mcp.json',
      'claude-code-risk-fork.disabled.settings.json',
    ]],
    ['codex', ['codex-risk-fork.disabled.toml']],
    ['cursor', [
      'cursor-risk-fork.disabled.mcp.json',
      'cursor-risk-fork.disabled.permissions.json',
    ]],
  ]);
  for (const [client, filenames] of expected) {
    const packet = JSON.parse(JSON.stringify(await createPacket(client)));
    assert.equal(verifyRiskForkClientAdoptionPacket(packet), true);
    assert.deepEqual(packet.outputs.map((entry) => entry.review_filename), filenames);
  }
});

test('deterministic client adoption verification rejects noncanonical output semantics', async () => {
  const packet = await createPacket();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const reject = (candidate) => {
    assert.throws(
      () => verifyRiskForkClientAdoptionPacket(candidate),
      (error) => error?.code === 'RISK_FORK_CLIENT_ADOPTION_INVALID'
        && /exact canonical client, output inventory, content, paths, posture/.test(error.message),
    );
    assert.equal(isRiskForkClientAdoptionPacket(candidate), false);
  };

  const activeContent = clone(packet);
  const activeCodex = activeContent.outputs.find((entry) => entry.client === 'codex');
  activeCodex.content = activeCodex.content.replace('enabled = false', 'enabled = true');
  reject(activeContent);

  const clientOutputMismatch = clone(packet);
  clientOutputMismatch.client = 'codex';
  reject(clientOutputMismatch);

  const duplicateOutput = clone(packet);
  duplicateOutput.outputs[1] = clone(duplicateOutput.outputs[0]);
  reject(duplicateOutput);

  const missingOutput = clone(packet);
  missingOutput.outputs.pop();
  reject(missingOutput);

  const extraOutput = clone(packet);
  extraOutput.outputs.push({
    ...clone(extraOutput.outputs[0]),
    review_filename: 'claude-code-risk-fork-copy.disabled.mcp.json',
  });
  reject(extraOutput);

  const contradictoryPosture = clone(packet);
  contradictoryPosture.outputs.find((entry) => entry.client === 'codex').native_default_off = false;
  reject(contradictoryPosture);
});

test('generated client files are inactive and expose only the gateway contract', async () => {
  const packet = await createPacket();
  assert.equal(packet.outputs.length, 5);
  assert.equal(packet.outputs.every((entry) => entry.review_filename.includes('.disabled.')), true);

  const codex = packet.outputs.find((entry) => entry.client === 'codex');
  assert.equal(codex.prompt_posture, 'explicit_per_tool_prompt');
  assert.match(codex.content, /enabled = false/);
  assert.match(codex.content, /required = true/);
  assert.match(codex.content, /default_tools_approval_mode = "prompt"/);
  assert.match(codex.content, /enabled_tools = \["risk_fork_protect"\]/);
  assert.match(codex.content, /approval_mode = "prompt"/);
  assert.doesNotMatch(codex.content, /enabled = true|approval_mode = "auto"/);

  const claudeMcp = JSON.parse(packet.outputs.find(
    (entry) => entry.review_filename.endsWith('.mcp.json') && entry.client === 'claude-code',
  ).content);
  assert.deepEqual(Object.keys(claudeMcp.mcpServers), ['risk_fork']);
  assert.equal(claudeMcp.mcpServers.risk_fork.type, 'stdio');
  assert.deepEqual(claudeMcp.mcpServers.risk_fork.env, {});
  const claudeSettingsEntry = packet.outputs.find(
    (entry) => entry.review_filename.endsWith('.settings.json') && entry.client === 'claude-code',
  );
  assert.equal(claudeSettingsEntry.prompt_posture, 'explicit_ask_rule_while_server_disabled');
  const claudeSettings = JSON.parse(claudeSettingsEntry.content);
  assert.deepEqual(claudeSettings.disabledMcpjsonServers, ['risk_fork']);
  assert.deepEqual(claudeSettings.permissions.ask, ['mcp__risk_fork__risk_fork_protect']);

  const cursorMcp = JSON.parse(packet.outputs.find(
    (entry) => entry.review_filename.endsWith('.mcp.json') && entry.client === 'cursor',
  ).content);
  assert.deepEqual(Object.keys(cursorMcp.mcpServers), ['risk_fork']);
  assert.equal(cursorMcp.mcpServers.risk_fork.type, 'stdio');
  assert.deepEqual(cursorMcp.mcpServers.risk_fork.env, {});
  const cursorPermissions = JSON.parse(packet.outputs.find(
    (entry) => entry.review_filename.endsWith('.permissions.json'),
  ).content);
  assert.deepEqual(cursorPermissions.mcpAllowlist, []);
  assert.deepEqual(
    packet.outputs.filter((entry) => entry.client === 'cursor').map((entry) => entry.prompt_posture),
    ['client_default_only', 'empty_workspace_allowlist_best_effort_block'],
  );

  for (const output of packet.outputs) {
    assert.doesNotMatch(output.content, /\bnpx(?:\.cmd)?\b|AGORAGENTIC_API_KEY|E2B_API_KEY/);
    if (output.review_filename.endsWith('.mcp.json') || output.client === 'codex') {
      assert.match(output.content, /one-tool-stdio-gate\.mjs/);
      assert.match(output.content, /risk-forkd\.js/);
    }
  }
});

test('client adoption rejects structural ambiguity without invoking accessors or proxy traps', async () => {
  const valid = {
    client: 'codex',
    gateEntrypoint,
    gateSha256: await hashFile(gateEntrypoint),
    gatewayEntrypoint,
    gatewaySha256: await hashFile(gatewayEntrypoint),
    nodeExecutable: process.execPath,
  };
  let accessorReads = 0;
  const accessor = { ...valid };
  Object.defineProperty(accessor, 'client', {
    enumerable: true,
    get() {
      accessorReads += 1;
      return 'codex';
    },
  });
  assert.throws(
    () => createRiskForkClientAdoptionPacket(accessor),
    (error) => error?.code === 'RISK_FORK_CLIENT_ADOPTION_INVALID',
  );
  assert.equal(accessorReads, 0);

  let proxyTraps = 0;
  const proxy = new Proxy(valid, {
    getPrototypeOf() {
      proxyTraps += 1;
      throw new Error('must not run');
    },
  });
  assert.throws(
    () => createRiskForkClientAdoptionPacket(proxy),
    (error) => error?.code === 'RISK_FORK_CLIENT_ADOPTION_INVALID',
  );
  assert.equal(proxyTraps, 0);
  assert.throws(
    () => createRiskForkClientAdoptionPacket({ ...valid, client: 'unsupported' }),
    (error) => error?.code === 'RISK_FORK_CLIENT_ADOPTION_INVALID',
  );
  assert.throws(
    () => createRiskForkClientAdoptionPacket({ ...valid, extra: true }),
    (error) => error?.code === 'RISK_FORK_CLIENT_ADOPTION_INVALID',
  );

  const originalIncludes = Array.prototype.includes;
  let prototypePollutionAccepted = false;
  try {
    Array.prototype.includes = () => true;
    try {
      createRiskForkClientAdoptionPacket({ ...valid, client: 'unsupported' });
      prototypePollutionAccepted = true;
    } catch {
      // Expected: client membership is checked without an inherited Array hook.
    }
  } finally {
    Array.prototype.includes = originalIncludes;
  }
  assert.equal(prototypePollutionAccepted, false);

  const packetWithAccessor = JSON.parse(JSON.stringify(await createPacket('codex')));
  let packetAccessorReads = 0;
  Object.defineProperty(packetWithAccessor, 'outputs', {
    enumerable: true,
    get() {
      packetAccessorReads += 1;
      return [];
    },
  });
  assert.throws(
    () => verifyRiskForkClientAdoptionPacket(packetWithAccessor),
    (error) => error?.code === 'RISK_FORK_CLIENT_ADOPTION_INVALID',
  );
  assert.equal(packetAccessorReads, 0);

  const packetWithProxy = JSON.parse(JSON.stringify(await createPacket('codex')));
  let packetProxyTraps = 0;
  packetWithProxy.gateway = new Proxy(packetWithProxy.gateway, {
    get() {
      packetProxyTraps += 1;
      throw new Error('must not run');
    },
  });
  assert.throws(
    () => verifyRiskForkClientAdoptionPacket(packetWithProxy),
    (error) => error?.code === 'RISK_FORK_CLIENT_ADOPTION_INVALID',
  );
  assert.equal(packetProxyTraps, 0);
});

test('client adoption caps aggregate UTF-8 verification for repeated large primitives', async () => {
  const packet = JSON.parse(JSON.stringify(await createPacket('codex')));
  const repeated = '\u00e9'.repeat(RISK_FORK_CLIENT_GATE_MAX_GATEWAY_BYTES / 2);
  packet.outputs = [repeated, repeated, repeated];

  assert.throws(
    () => verifyRiskForkClientAdoptionPacket(packet),
    (error) => error?.code === 'RISK_FORK_CLIENT_ADOPTION_INVALID'
      && /aggregate UTF-8 verification limit/.test(error.message),
  );
});

test('client adoption CLI previews without writes and writes only inactive review files', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'risk-fork-client-adoption-'));
  try {
    const oversizedSource = path.join(temporaryRoot, 'oversized-source');
    const oversizedGateway = path.join(oversizedSource, 'risk-forkd.js');
    await mkdir(oversizedSource);
    await writeFile(
      oversizedGateway,
      Buffer.alloc(RISK_FORK_CLIENT_GATE_MAX_GATEWAY_BYTES + 1, 0x61),
    );
    const before = await readdir(temporaryRoot);
    const unpairedGateway = runCli([
      'plan', '--client', 'all', '--gateway', gatewayEntrypoint,
    ]);
    assert.equal(unpairedGateway.status, 64);
    assert.match(
      JSON.parse(unpairedGateway.stderr).message,
      /--gateway and --gateway-sha256 must be supplied together/,
    );
    const unpairedGatewayHash = runCli([
      'plan', '--client', 'all', '--gateway-sha256', await hashFile(gatewayEntrypoint),
    ]);
    assert.equal(unpairedGatewayHash.status, 64);
    assert.match(
      JSON.parse(unpairedGatewayHash.stderr).message,
      /--gateway and --gateway-sha256 must be supplied together/,
    );
    const oversizedPlan = runCli([
      'plan', '--client', 'all', '--gateway', oversizedGateway,
      '--gateway-sha256', await hashFile(oversizedGateway),
    ]);
    assert.equal(oversizedPlan.status, 64);
    assert.match(
      JSON.parse(oversizedPlan.stderr).message,
      new RegExp(`at most ${RISK_FORK_CLIENT_GATE_MAX_GATEWAY_BYTES} bytes`),
    );
    const oversizedOutput = path.join(temporaryRoot, 'oversized-output');
    const oversizedWrite = runCli([
      'write-review', '--client', 'all', '--gateway', oversizedGateway,
      '--gateway-sha256', await hashFile(oversizedGateway),
      '--output', oversizedOutput, '--yes',
    ]);
    assert.equal(oversizedWrite.status, 64);
    assert.deepEqual(await readdir(temporaryRoot), before);

    const preview = runCli(['plan', '--client', 'all']);
    assert.equal(preview.status, 0, preview.stderr);
    const previewPacket = JSON.parse(preview.stdout);
    const currentGatewayBytes = await readFile(gatewayEntrypoint);
    const currentGatewayHash = hashBytes(currentGatewayBytes);
    const plannerSource = await readFile(cliEntrypoint, 'utf8');
    const reviewedSourceBinding = plannerSource.match(
      /const REVIEWED_SOURCE_CHECKOUT_GATEWAY_SHA256_ALLOWLIST = Object\.freeze\(\[([\s\S]*?)\]\);/,
    );
    assert.ok(reviewedSourceBinding, 'planner must expose literal reviewed source bindings');
    const reviewedSourceHashes = [...reviewedSourceBinding[1].matchAll(
      /'(sha256:[a-f0-9]{64})'/g,
    )].map((match) => match[1]);
    const workingGatewayText = currentGatewayBytes.toString('utf8');
    assert.equal(Buffer.from(workingGatewayText, 'utf8').equals(currentGatewayBytes), true);
    assert.equal(/\r(?!\n)/.test(workingGatewayText), false, 'gateway must contain no bare CR');
    const lfSource = Buffer.from(workingGatewayText.replaceAll('\r\n', '\n'), 'utf8');
    assert.equal(lfSource.includes(0x0d), false, 'reviewed LF form must contain no CR bytes');
    const crlfSource = Buffer.from(lfSource.toString('utf8').replaceAll('\n', '\r\n'), 'utf8');
    assert.equal(/\r(?!\n)/.test(crlfSource.toString('utf8')), false);
    assert.equal(
      Buffer.from(crlfSource.toString('utf8').replaceAll('\r\n', '\n'), 'utf8').equals(lfSource),
      true,
    );
    assert.deepEqual(reviewedSourceHashes, [hashBytes(lfSource), hashBytes(crlfSource)]);
    assert.equal(
      currentGatewayBytes.equals(lfSource) || currentGatewayBytes.equals(crlfSource),
      true,
      'working gateway must be exactly the reviewed LF or CRLF byte form',
    );
    assert.equal(previewPacket.gateway.gateway_sha256, currentGatewayHash);
    assert.equal(previewPacket.controls.writes_performed, false);
    assert.deepEqual(await readdir(temporaryRoot), before);

    const refused = runCli([
      'write-review', '--client', 'all', '--output', path.join(temporaryRoot, 'refused'),
    ]);
    assert.equal(refused.status, 64);
    assert.equal(JSON.parse(refused.stderr).status, 'refused');
    assert.deepEqual(await readdir(temporaryRoot), before);

    const output = path.join(temporaryRoot, 'packet');
    const written = runCli([
      'write-review', '--client', 'all', '--output', output, '--yes',
    ]);
    assert.equal(written.status, 0, written.stderr);
    const result = JSON.parse(written.stdout);
    assert.equal(result.manifest.client, 'all');
    assert.equal(result.manifest.controls.active_client_paths_written, false);
    assert.equal(result.manifest.controls.client_enabled, false);
    assert.equal(result.manifest.controls.provider_calls, 0);
    assert.equal(result.manifest.controls.network_used, false);
    const filenames = (await readdir(output)).sort();
    assert.deepEqual(filenames, [
      'claude-code-risk-fork.disabled.mcp.json',
      'claude-code-risk-fork.disabled.settings.json',
      'codex-risk-fork.disabled.toml',
      'cursor-risk-fork.disabled.mcp.json',
      'cursor-risk-fork.disabled.permissions.json',
      'manifest.json',
    ]);
    assert.equal(filenames.some((name) => [
      '.mcp.json', 'config.toml', 'mcp.json', 'permissions.json', 'settings.json',
    ].includes(name)), false);

    const verified = runCli([
      'verify-review', '--manifest', path.join(output, 'manifest.json'),
    ]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.deepEqual(JSON.parse(verified.stdout), {
      schema: 'agoragentic.risk-fork.client-adoption-review-verification.v1',
      status: 'passed',
      files_verified: 5,
      active_client_paths_written: false,
      client_enabled: false,
      provider_calls: 0,
      network_used: false,
      live_traffic_protected: false,
    });
    const oversizedVerify = runCli([
      'verify-review', '--manifest', path.join(output, 'manifest.json'),
      '--gateway', oversizedGateway,
      '--gateway-sha256', await hashFile(oversizedGateway),
    ]);
    assert.equal(oversizedVerify.status, 64);
    assert.match(
      JSON.parse(oversizedVerify.stderr).message,
      new RegExp(`at most ${RISK_FORK_CLIENT_GATE_MAX_GATEWAY_BYTES} bytes`),
    );

    const manifestPath = path.join(output, 'manifest.json');
    const forgedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const forgedFilename = path.join(output, forgedManifest.files[0].filename);
    await writeFile(forgedFilename, '{}\n', 'utf8');
    forgedManifest.files[0].sha256 = await hashFile(forgedFilename);
    await writeFile(manifestPath, `${JSON.stringify(forgedManifest, null, 2)}\n`, 'utf8');
    const forged = runCli(['verify-review', '--manifest', manifestPath]);
    assert.equal(forged.status, 64);
    assert.match(JSON.parse(forged.stderr).message, /exact current source packet/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('client adoption planning rejects a gateway reached through a linked ancestor', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'risk-fork-client-canonical-'));
  try {
    const actualParent = path.join(temporaryRoot, 'actual');
    const linkedParent = path.join(temporaryRoot, 'linked');
    await mkdir(actualParent);
    await writeFile(
      path.join(actualParent, 'risk-forkd.js'),
      await readFile(gatewayEntrypoint),
    );
    try {
      await symlink(actualParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM') {
        t.skip('directory links are unavailable on this Windows runner');
        return;
      }
      throw error;
    }
    const linkedGateway = path.join(linkedParent, 'risk-forkd.js');
    const planned = runCli([
      'plan', '--client', 'all', '--gateway', linkedGateway,
      '--gateway-sha256', await hashFile(linkedGateway),
    ]);
    assert.equal(planned.status, 64);
    assert.match(JSON.parse(planned.stderr).message, /exact canonical path/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('client adoption rejects credential-shaped paths before packet serialization', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'risk-fork-client-path-scan-'));
  try {
    const credentialShapedParent = path.join(temporaryRoot, `amk_${'a'.repeat(64)}`);
    const credentialShapedGateway = path.join(credentialShapedParent, 'risk-forkd.js');
    await mkdir(credentialShapedParent);
    await writeFile(credentialShapedGateway, await readFile(gatewayEntrypoint));

    const planned = runCli([
      'plan', '--client', 'all', '--gateway', credentialShapedGateway,
      '--gateway-sha256', `sha256:${'0'.repeat(64)}`,
    ]);
    assert.equal(planned.status, 64);
    assert.equal(planned.stdout, '');
    assert.match(JSON.parse(planned.stderr).message, /credential-shaped material/);
    assert.doesNotMatch(planned.stderr, /amk_[a-f0-9]{64}/);

    const fullCredentialPaths = [
      {
        gateway: path.join(temporaryRoot, 'Basic dTpw', 'risk-forkd.js'),
        forbidden: /dTpw/,
      },
      {
        gateway: path.join(
          temporaryRoot,
          'synthetic-user:synthetic-pass@example.test',
          'risk-forkd.js',
        ),
        forbidden: /synthetic-user|synthetic-pass/,
      },
    ];
    for (const { gateway, forbidden } of fullCredentialPaths) {
      const fullCredentialPlan = runCli([
        'plan', '--client', 'all', '--gateway', gateway,
        '--gateway-sha256', `sha256:${'0'.repeat(64)}`,
      ]);
      assert.equal(fullCredentialPlan.status, 64);
      assert.equal(fullCredentialPlan.stdout, '');
      assert.match(JSON.parse(fullCredentialPlan.stderr).message, /credential-shaped material/);
      assert.doesNotMatch(fullCredentialPlan.stderr, forbidden);

      assert.throws(
        () => createRiskForkClientAdoptionPacket({
          client: 'all',
          gateEntrypoint,
          gateSha256: `sha256:${'0'.repeat(64)}`,
          gatewayEntrypoint: gateway,
          gatewaySha256: `sha256:${'1'.repeat(64)}`,
          nodeExecutable: process.execPath,
        }),
        /credential-shaped material/,
      );
    }

    assert.throws(
      () => createRiskForkClientAdoptionPacket({
        client: 'all',
        gateEntrypoint,
        gateSha256: `sha256:${'0'.repeat(64)}`,
        gatewayEntrypoint: credentialShapedGateway,
        gatewaySha256: `sha256:${'1'.repeat(64)}`,
        nodeExecutable: process.execPath,
      }),
      /credential-shaped material/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('client adoption planning rejects a paused same-size partial version by reviewed hash', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'risk-fork-client-stability-'));
  try {
    const gateway = path.join(temporaryRoot, 'risk-forkd.js');
    const size = 256 * 1024;
    const firstVersion = Buffer.alloc(size, 0x61);
    const secondVersion = Buffer.alloc(size, 0x62);
    const firstHash = `sha256:${createHash('sha256').update(firstVersion).digest('hex')}`;
    const secondHash = `sha256:${createHash('sha256').update(secondVersion).digest('hex')}`;
    await writeFile(gateway, firstVersion);

    const handle = await open(gateway, 'r+');
    try {
      const partial = secondVersion.subarray(0, size / 2);
      const { bytesWritten } = await handle.write(partial, 0, partial.length, 0);
      assert.equal(bytesWritten, partial.length);
      await handle.sync();
    } finally {
      await handle.close();
    }

    for (const reviewedHash of [firstHash, secondHash]) {
      const refused = runCli([
        'plan', '--client', 'all', '--gateway', gateway,
        '--gateway-sha256', reviewedHash,
      ]);
      assert.equal(refused.status, 64);
      assert.equal(refused.stdout, '');
      assert.match(
        JSON.parse(refused.stderr).message,
        /exact bytes do not match the reviewed SHA-256/,
      );
    }

    await writeFile(gateway, secondVersion);
    const mismatchedFullVersion = runCli([
      'plan', '--client', 'all', '--gateway', gateway,
      '--gateway-sha256', firstHash,
    ]);
    assert.equal(mismatchedFullVersion.status, 64);
    assert.match(
      JSON.parse(mismatchedFullVersion.stderr).message,
      /exact bytes do not match the reviewed SHA-256/,
    );
    const planned = runCli([
      'plan', '--client', 'all', '--gateway', gateway,
      '--gateway-sha256', secondHash,
    ]);
    assert.equal(planned.status, 0, planned.stderr);
    assert.equal(JSON.parse(planned.stdout).gateway.gateway_sha256, secondHash);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
