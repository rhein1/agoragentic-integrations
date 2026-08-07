#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AnyDocEvidenceError,
  convertFileToEvidence,
} from '../agoragentic-anydoc.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(await readFile(join(HERE, 'cases.json'), 'utf8'));
const reportPath = process.argv[2] || join(HERE, 'report.json');

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function excerpt(markdown) {
  return String(markdown)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

const results = [];
let failures = 0;

for (const item of cases.cases) {
  const startedAt = Date.now();
  const fixture = join(HERE, 'generated', item.file);

  try {
    const result = await convertFileToEvidence(fixture, {
      format: item.format,
      maxInputBytes: 10 * 1024 * 1024,
      maxMarkdownChars: 500_000,
      maxEvidenceUnits: 128,
    });

    assert.equal(item.expect_conversion, true, `${item.id} unexpectedly converted`);
    assert.equal(result.parser.package_version, cases.anydoc_version);
    assert.equal(result.parser.format, item.format);
    assert.equal(result.parser.network_used, false);
    assert.equal(result.parser.ocr_used, false);
    assert.equal(result.risk.source_exact, false);
    assert.equal(result.risk.semantic_risk, item.expected_risk);
    assert.equal(result.ecf_handoff.context_packet_ready, false);
    assert.equal(result.ecf_handoff.trap_scan_status, 'not_scanned');
    assert.equal(result.ecf_handoff.receipt.status, 'pending');
    assert.equal(result.authority.grants_spend, false);
    assert.equal(result.authority.grants_publication, false);
    assert.match(result.source.source_hash, /^sha256:[a-f0-9]{64}$/);
    assert.match(result.output.output_hash, /^sha256:[a-f0-9]{64}$/);
    assert(result.output.evidence_units.length > 0);

    for (const limitation of item.expected_limitations || []) {
      assert(
        result.risk.limitations.includes(limitation),
        `${item.id} missing limitation ${limitation}`,
      );
    }
    for (const token of item.expected_markdown_tokens || []) {
      assert(
        result.output.markdown.includes(token),
        `${item.id} missing expected Markdown token ${JSON.stringify(token)}`,
      );
    }

    results.push({
      id: item.id,
      status: 'pass',
      conversion: 'completed_with_declared_limits',
      source_hash: result.source.source_hash,
      output_hash: result.output.output_hash,
      markdown_hash_recomputed: sha256(result.output.markdown),
      markdown_excerpt: excerpt(result.output.markdown),
      semantic_risk: result.risk.semantic_risk,
      limitations: result.risk.limitations,
      evidence_units: result.output.evidence_units.length,
      structure: result.output.structure,
      context_packet_ready: result.ecf_handoff.context_packet_ready,
      authority_granted: false,
      semantic_observations: item.semantic_observations || [],
      duration_ms: Date.now() - startedAt,
    });
  } catch (error) {
    if (item.expect_conversion === false) {
      assert(error instanceof AnyDocEvidenceError, `${item.id} returned an unknown error`);
      assert.equal(error.code, item.expected_error_code);
      results.push({
        id: item.id,
        status: 'pass',
        conversion: 'failed_closed_as_expected',
        error_code: error.code,
        cause_code: error.causeCode,
        retryable: error.retryable,
        ocr_fallback_automatically_used: false,
        authority_granted: false,
        duration_ms: Date.now() - startedAt,
      });
      continue;
    }

    failures += 1;
    results.push({
      id: item.id,
      status: 'fail',
      error: error?.message || String(error),
      error_code: error?.code || null,
      authority_granted: false,
      duration_ms: Date.now() - startedAt,
    });
  }
}

const report = {
  schema: 'agoragentic.anydoc-semantic-conformance-report.v1',
  generated_at: new Date().toISOString(),
  upstream: {
    repository: 'https://github.com/firecrawl/anydoc',
    package: '@firecrawl/anydoc',
    version: cases.anydoc_version,
    partnership_claimed: false,
  },
  scope: {
    local_only: true,
    no_network: true,
    no_ocr_provider: true,
    no_spend: true,
    no_publication: true,
    no_trust_mutation: true,
  },
  summary: {
    cases: results.length,
    passed: results.filter(result => result.status === 'pass').length,
    failed: failures,
    production_listing_ready: false,
  },
  results,
  non_claims: [
    'A passing report is not source-exactness certification.',
    'A passing report is not universal document safety.',
    'A conversion success is not semantic fidelity proof.',
    'No OCR, paid provider, marketplace publication, or x402 path was exercised.',
  ],
};

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report.summary));
if (failures > 0) process.exit(1);
