#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  hashRef,
  normalizeRunpayReceiptFixture,
  normalizeRunpayServiceFixture,
} from './normalize.mjs';

export const RUNPAY_REPLAY_SCHEMA = 'agoragentic.interchange.runpay-offline-replay.v1';

const root = path.dirname(fileURLToPath(import.meta.url));

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}

export async function buildRunpayReplay() {
  const [consensusFixture, phoneFixture, receiptFixture] = await Promise.all([
    readJson('fixtures/consensus-aggregator.json'),
    readJson('fixtures/phone-validator.json'),
    readJson('fixtures/phone-validator-receipt.json'),
  ]);
  const services = [consensusFixture, phoneFixture]
    .map(normalizeRunpayServiceFixture)
    .sort((left, right) => left.source.service_id.localeCompare(right.source.service_id));
  const receipt = normalizeRunpayReceiptFixture({ receiptFixture, serviceFixture: phoneFixture });
  const body = {
    schema: RUNPAY_REPLAY_SCHEMA,
    fixture_contract_at: '2026-09-09T17:30:24Z',
    services,
    receipt,
    assertions: {
      service_count: services.length,
      source_service_count_claim: 206,
      services_with_declared_input_schema: services.filter(
        (service) => service.capability_card_input.input_schema.status === 'declared',
      ).length,
      services_with_nonmissing_output_schema: services.filter(
        (service) => service.capability_card_input.output_schema.status !== 'missing',
      ).length,
      all_services_ineligible: services.every((service) => service.eligibility.eligible === false),
      settlement_confirmed: receipt.settlement.confirmed,
    },
    safety: {
      deterministic: true,
      offline: true,
      network_used: false,
      credentials_used: false,
      provider_invoked: false,
      payment_attempted: false,
      funds_moved: false,
      listing_published: false,
      trust_mutated: false,
    },
  };
  return { ...body, replay_hash: hashRef(body) };
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') out.outputPath = argv[++index];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown_argument:${arg}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node interchange/runpay/replay.mjs [--out <report.json>]');
    return;
  }
  const replay = await buildRunpayReplay();
  const text = `${JSON.stringify(replay, null, 2)}\n`;
  if (args.outputPath) await writeFile(args.outputPath, text, 'utf8');
  else process.stdout.write(text);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}
