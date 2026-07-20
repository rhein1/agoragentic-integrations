#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildContextPacket,
  buildPolicySummary,
  validatePolicy,
} from '../../micro-ecf/src/core.mjs';

const exampleDir = path.dirname(fileURLToPath(import.meta.url));

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function runProof({ outputDir = path.join(exampleDir, 'out') } = {}) {
  const policy = await readJson(path.join(exampleDir, 'policy.json'));
  const source = await readJson(path.join(exampleDir, 'fixtures', 'research-notes.json'));

  validatePolicy(policy);

  if (policy.budget_policy.max_daily_spend_usdc !== 0
    || !policy.tool_policy.denied_tools.includes('marketplace_execute')
    || !policy.tool_policy.denied_tools.includes('wallet_settlement')) {
    throw new Error('The local proof requires a zero-cost, network-free, provider-free, wallet-free policy.');
  }

  const sourceMap = {
    schema: 'agoragentic.micro-ecf.source-map.v1',
    generated_at: 'deterministic-local-fixture',
    root: { label: 'governed-research-agent', path: '.' },
    limits: { max_files: 1, max_file_bytes: 200000, raw_content_exported: false },
    sources: source.notes.map((note, index) => ({
      id: `src_${note.source_id}`,
      path: 'fixtures/research-notes.json',
      type: 'local_research_note',
      hash: `sha256:${hash(note)}`,
      summary: note.text,
      citation_id: `cite_${index + 1}`,
      provenance: { local_only: true, raw_content_exported: false, fixture: true },
    })),
    blocked: [],
    generated: [],
    stats: { included_sources: source.notes.length, blocked_paths: 0, generated_sources_excluded: 0 },
  };
  const policySummary = buildPolicySummary(policy);
  const contextPacket = buildContextPacket(policy, sourceMap);

  const quote = {
    schema: 'agoragentic.governed-research.local-quote.v1',
    route: 'local_deterministic_research',
    price_usdc: 0,
    payment_required: false,
    execution_boundary: 'local_fixture_only',
    policy_hash: hash(policy),
  };
  const report = {
    schema: 'agoragentic.governed-research.local-report.v1',
    topic: source.topic,
    summary: source.notes.map((note) => note.text).join(' '),
    citations: contextPacket.citations,
    source_hash: hash(source),
  };
  const receiptCore = {
    schema: 'agoragentic.governed-research.local-receipt.v1',
    route: quote.route,
    status: 'completed',
    cost_usdc: 0,
    settlement: { network: 'none', status: 'not_applicable' },
    quote_hash: hash(quote),
    output_hash: hash(report),
    citations: report.citations,
  };
  const receipt = { ...receiptCore, receipt_id: `local_${hash(receiptCore).slice(0, 20)}` };

  const checks = {
    policy_hash_matches: quote.policy_hash === hash(policy),
    quote_is_zero_cost: quote.price_usdc === 0 && quote.payment_required === false,
    output_hash_matches: receipt.output_hash === hash(report),
    citations_present: report.citations.length === source.notes.length,
    context_packet_matches_sources: contextPacket.sources.length === source.notes.length,
    settlement_not_applicable: receipt.settlement.network === 'none' && receipt.settlement.status === 'not_applicable',
  };
  const reconciliation = {
    schema: 'agoragentic.governed-research.local-reconciliation.v1',
    ok: Object.values(checks).every(Boolean),
    checks,
    authority_boundary: {
      local_only: true,
      network_access: false,
      provider_execution: false,
      wallet_access: false,
      spend_enabled: false,
      deployment_enabled: false,
      publication_enabled: false,
    },
  };

  await mkdir(outputDir, { recursive: true });
  const artifacts = {
    contextPacket: path.join(outputDir, 'context-packet.json'),
    policySummary: path.join(outputDir, 'policy-summary.json'),
    quote: path.join(outputDir, 'quote.json'),
    report: path.join(outputDir, 'research-report.json'),
    receipt: path.join(outputDir, 'receipt.json'),
    reconciliation: path.join(outputDir, 'reconciliation.json'),
  };
  await Promise.all([
    writeJson(artifacts.contextPacket, contextPacket),
    writeJson(artifacts.policySummary, policySummary),
    writeJson(artifacts.quote, quote),
    writeJson(artifacts.report, report),
    writeJson(artifacts.receipt, receipt),
    writeJson(artifacts.reconciliation, reconciliation),
  ]);

  return { ok: reconciliation.ok, artifacts, policySummary, contextPacket, quote, report, receipt, reconciliation };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await runProof();
  process.stdout.write(`${JSON.stringify({ ok: result.ok, receipt_id: result.receipt.receipt_id, artifacts: result.artifacts }, null, 2)}\n`);
}
