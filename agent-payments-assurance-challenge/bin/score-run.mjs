#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, scoreChallengeRun } from '../src/scorer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2) {
  console.error('Usage: agora-assurance-score <run.json> [challenge.json]');
  process.exit(2);
}
const [runPath] = args;
const challengePath = args[1] || resolve(here, '../scenarios/challenge-v1.json');
try {
  const challenge = await readJson(challengePath);
  const run = await readJson(runPath);
  const report = scoreChallengeRun(challenge, run);
  console.log(JSON.stringify(report, null, 2));
  if (!report.all_scenarios_passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
