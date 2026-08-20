#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { validateJsonSchema } from './lib/validate-json-schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ledgerPath = path.join(root, 'interchange', 'evidence', 'interchange-production-research-ledger.v1.json');
const schemaPath = path.join(root, 'interchange', 'schemas', 'interchange-production-research-ledger.schema.json');
const integrationsPath = path.join(root, 'integrations.json');
const findingsPath = path.join(root, 'interchange', 'research', 'PRODUCTION_FINDINGS.md');
const chronologyPath = path.join(root, 'interchange', 'research', 'CHRONOLOGY.md');
const x402CaseStudyPath = path.join(root, 'interchange', 'research', 'X402_PRODUCTION_CASE_STUDY.md');
const claimMatrixPath = path.join(root, 'interchange', 'research', 'CLAIM_EVIDENCE_MATRIX.md');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertUnique(values, label) {
  assert(new Set(values).size === values.length, `${label} contains duplicates`);
}

const ledger = readJson(ledgerPath);
const schema = readJson(schemaPath);
const integrations = readJson(integrationsPath);
const findingsDocument = fs.readFileSync(findingsPath, 'utf8');
const chronologyDocument = fs.readFileSync(chronologyPath, 'utf8');
const x402CaseStudy = fs.readFileSync(x402CaseStudyPath, 'utf8');
const claimMatrix = fs.readFileSync(claimMatrixPath, 'utf8');

validateJsonSchema(ledger, schema);

assert(
  ledger.schema === 'agoragentic.interchange-production-research-ledger.v1',
  'unexpected research ledger schema'
);
assert(
  schema.$id === 'https://agoragentic.com/schema/interchange-production-research-ledger.v1.json',
  'unexpected research ledger schema id'
);
assert(Number.isFinite(Date.parse(ledger.generated_at)), 'generated_at must be a date-time');
assert(Array.isArray(ledger.external_experiments) && ledger.external_experiments.length >= 5, 'expected external experiments');
assert(Array.isArray(ledger.source_change_groups) && ledger.source_change_groups.length >= 1, 'expected source change groups');
assert(Array.isArray(ledger.findings) && ledger.findings.length >= 1, 'expected findings');

assertUnique(ledger.external_experiments.map((entry) => entry.id), 'experiment ids');
assertUnique(ledger.source_change_groups.map((entry) => entry.id), 'source change group ids');
assertUnique(ledger.findings.map((entry) => entry.id), 'finding ids');
for (const finding of ledger.findings) {
  assert(findingsDocument.includes(`| ${finding.id} |`), `${finding.id}: missing from human findings ledger`);
}

const sourcePrs = ledger.source_change_groups.flatMap((group) => group.pull_requests || []);
assertUnique(sourcePrs, 'source change pull requests');
const sourcePrSet = new Set(sourcePrs);
for (const finding of ledger.findings) {
  for (const pullRequest of finding.fix_pull_requests || []) {
    assert(sourcePrSet.has(pullRequest), `${finding.id}: fix PR ${pullRequest} missing from source change groups`);
  }
}

for (const experiment of ledger.external_experiments) {
  assert(Array.isArray(experiment.evidence) && experiment.evidence.length > 0, `${experiment.id}: evidence missing`);
  assert(Array.isArray(experiment.limitations) && experiment.limitations.length > 0, `${experiment.id}: limitations missing`);
  for (const evidence of experiment.evidence) {
    assert(/^https:\/\//.test(evidence.url), `${experiment.id}: evidence URL must use HTTPS`);
  }
  for (const [authority, enabled] of Object.entries(experiment.authority_after || {})) {
    assert(enabled === false, `${experiment.id}: retained authority ${authority} must remain false in this research record`);
  }
}

const knownTransactions = new Map([
  ['0x9b01b4b465e1a764182f796095923fb341608175b01752d6b80631b779bb7d44', '5000'],
  ['0x705c7a146774289c9e26aea991eac31c82bede037f497b4994bf3d32bbcc6e95', '10000'],
]);
for (const experiment of ledger.external_experiments.filter((entry) => entry.chain_evidence)) {
  const tx = experiment.chain_evidence.tx_hash.toLowerCase();
  assert(knownTransactions.has(tx), `${experiment.id}: unreviewed chain transaction`);
  assert(
    experiment.chain_evidence.amount_atomic === knownTransactions.get(tx),
    `${experiment.id}: chain amount drift`
  );
  assert(experiment.chain_evidence.status === 'success', `${experiment.id}: chain status must be success`);
  assert(x402CaseStudy.includes(tx), `${experiment.id}: chain transaction missing from x402 case study`);
}

assert(chronologyDocument.includes(ledger.program.charter_url), 'chronology missing original charter');
assert(chronologyDocument.includes(ledger.program.successor_gate_url), 'chronology missing successor gate');
for (const qualifier of ['recruited external buyer', 'owner-seeded internal balance', 'TOFU key-control']) {
  assert(claimMatrix.includes(qualifier), `claim matrix missing qualifier: ${qualifier}`);
}

const requiredDiscoveryEntries = {
  interchange_research_record: 'interchange/research/README.md',
  interchange_research_chronology: 'interchange/research/CHRONOLOGY.md',
  interchange_research_a2a_case_study: 'interchange/research/A2A_FEDERATION_CASE_STUDY.md',
  interchange_research_x402_case_study: 'interchange/research/X402_PRODUCTION_CASE_STUDY.md',
  interchange_research_production_findings: 'interchange/research/PRODUCTION_FINDINGS.md',
  interchange_research_claim_matrix: 'interchange/research/CLAIM_EVIDENCE_MATRIX.md',
  interchange_research_evidence_gaps: 'interchange/research/EVIDENCE_GAPS.md',
  interchange_research_references: 'interchange/research/REFERENCES.md',
  interchange_production_research_ledger: 'interchange/evidence/interchange-production-research-ledger.v1.json',
  interchange_production_research_ledger_schema: 'interchange/schemas/interchange-production-research-ledger.schema.json',
};

for (const [key, relativePath] of Object.entries(requiredDiscoveryEntries)) {
  assert(integrations.discovery?.[key] === relativePath, `integrations.json discovery pointer missing: ${key}`);
  assert(fs.existsSync(path.join(root, relativePath)), `discovery target missing: ${relativePath}`);
}

console.log('Interchange research evidence verification passed.');
