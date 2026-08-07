#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, scoreChallengeRun } from '../src/scorer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runPath = process.argv[2];
if (!runPath) {
  console.error('Usage: agora-assurance-score <run.json> [challenge.json]');
  process.exit(2);
}
const challengePath = process.argv[3] || resolve(here, '../scenarios/challenge-v1.json');
try {
  const [challenge, run] = await Promise.all([readJson(challengePath), readJson(runPath)]);
  console.log(JSON.stringify(scoreChallengeRun(challenge, run), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
