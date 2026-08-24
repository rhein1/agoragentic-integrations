#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'integrations.json');
const outputPath = path.join(root, 'docs', 'INTEGRATION_CAPABILITY_STATUS.md');

function normalizeLineEndings(text) {
  return text.replaceAll('\r\n', '\n');
}

function cell(value) {
  return String(value ?? 'none').replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');
}

function relativeLink(label, target) {
  return target ? `[${cell(label)}](../${target})` : cell(label);
}

export function renderCapabilityStatus(manifest) {
  const integrations = (manifest.integrations || [])
    .filter((integration) => integration.capability_record)
    .sort((left, right) => left.id.localeCompare(right.id));

  const lines = [
    '# Generated integration capability status',
    '',
    '> Generated from [`integrations.json`](../integrations.json) by `scripts/generate-integration-capability-status.mjs`. Do not edit this table independently.',
    '>',
    '> These records describe bounded implementation and evidence surfaces. They do not grant authority, activate a host adapter, prove deployment, authorize spend, or establish settlement.',
    '',
    `Capability records: **${integrations.length}** of **${manifest.integrations?.length || 0}** catalog entries.`,
    '',
    '## Capabilities',
    '',
    '| Integration | Router client | Manifest mapping | Pre-action enforcement | Post-action evidence | Approval support | Receipt support | Agent OS export |',
    '|---|---|---|---|---|---|---|---|',
  ];

  for (const integration of integrations) {
    const capabilities = integration.capability_record.capabilities;
    lines.push([
      relativeLink(integration.name, integration.docs || integration.path),
      cell(capabilities.router_client),
      cell(capabilities.manifest_mapping),
      cell(capabilities.pre_action_enforcement),
      cell(capabilities.post_action_evidence),
      cell(capabilities.approval_support),
      cell(capabilities.receipt_support),
      cell(capabilities.agent_os_export),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push(
    '',
    '## Evidence and requirements',
    '',
    '| Integration | Host version tested | Proof class | Last verified | Evidence | Network required | Spend capable |',
    '|---|---|---|---|---|---|---|',
  );

  for (const integration of integrations) {
    const { evidence, requirements } = integration.capability_record;
    lines.push([
      cell(integration.name),
      cell(evidence.host_version_tested),
      cell(evidence.proof_class),
      cell(evidence.last_verified_at || 'not verified'),
      evidence.evidence_ref ? relativeLink(evidence.evidence_ref, evidence.evidence_ref) : 'none',
      requirements.network_required ? 'yes' : 'no',
      requirements.spend_capable ? 'yes' : 'no',
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push(
    '',
    '## Interpretation',
    '',
    '- `example` and `documented` are weaker than tested runtime support.',
    '- `static` proof means source or documentation was inspected; it is not host-runtime evidence.',
    '- A local or hosted execution receipt is not settlement evidence.',
    '- `spend_capable: yes` describes a reachable code path, not authority to spend.',
    '- Unknown host versions remain `unknown` until exact runtime evidence is recorded.',
    '',
  );

  return lines.join('\n');
}

export function verifyCapabilityStatus({ manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')), expected = fs.readFileSync(outputPath, 'utf8') } = {}) {
  const generated = renderCapabilityStatus(manifest);
  const normalizedExpected = normalizeLineEndings(expected);
  return { ok: generated === normalizedExpected, generated, expected: normalizedExpected };
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const generated = renderCapabilityStatus(manifest);
  if (process.argv.includes('--write')) {
    fs.writeFileSync(outputPath, generated, 'utf8');
    console.log(`Wrote ${path.relative(root, outputPath)}`);
    return;
  }
  if (process.argv.includes('--check')) {
    if (!verifyCapabilityStatus({ manifest }).ok) {
      console.error('Integration capability status is stale. Run: node scripts/generate-integration-capability-status.mjs --write');
      process.exitCode = 1;
      return;
    }
    console.log('Integration capability status is current.');
    return;
  }
  process.stdout.write(generated);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
