#!/usr/bin/env node

import { readJson, verifyConformanceReceipt } from '../src/conformance.mjs';

const packageRoot = new URL('../', import.meta.url);

async function main() {
  const [reportPath, receiptPath] = process.argv.slice(2);
  if (!reportPath || !receiptPath) {
    throw new TypeError('Usage: verify-conformance-receipt <report.json> <receipt.json>');
  }
  const [manifest, vectorSet, report, receipt] = await Promise.all([
    readJson(new URL('conformance/manifest.v1.json', packageRoot)),
    readJson(new URL('conformance/vectors.v1.json', packageRoot)),
    readJson(reportPath),
    readJson(receiptPath),
  ]);
  const result = verifyConformanceReceipt({ manifest, vectorSet, report, receipt });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.verified ? 0 : 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
