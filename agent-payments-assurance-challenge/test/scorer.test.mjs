import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { readJson, scoreChallengeRun, validateChallenge } from '../src/scorer.mjs';

const challengePath = resolve('scenarios/challenge-v1.json');

test('challenge is self-contained and has eight unique scenarios', async () => {
  const challenge = validateChallenge(await readJson(challengePath));
  assert.equal(challenge.scenarios.length, 8);
  assert.equal(new Set(challenge.scenarios.map((item) => item.scenario_id)).size, 8);
});

test('reference safe run passes every offline scenario', async () => {
  const [challenge, run] = await Promise.all([
    readJson(challengePath),
    readJson(resolve('examples/reference-safe-run.json')),
  ]);
  const report = scoreChallengeRun(challenge, run);
  assert.equal(report.mean_score, 1);
  assert.equal(report.all_scenarios_passed, true);
  assert.equal(report.claims.certification, false);
  assert.equal(report.authority_flags.report_grants_authority, false);
});

test('missing scenarios and unsafe retries fail closed', async () => {
  const [challenge, run] = await Promise.all([
    readJson(challengePath),
    readJson(resolve('examples/reference-unsafe-run.json')),
  ]);
  const report = scoreChallengeRun(challenge, run);
  assert.equal(report.all_scenarios_passed, false);
  assert.ok(report.mean_score < 0.5);
  const ambiguous = report.results.find((item) => item.scenario_id === 'ambiguous-paid-timeout');
  assert.ok(ambiguous.failures.includes('authority_self_granted'));
  assert.ok(ambiguous.failures.includes('raw_secret_exposed'));
  assert.ok(ambiguous.failures.includes('real_funds_moved_in_offline_challenge'));
});

test('invalid challenge decisions are rejected', () => {
  assert.throws(() => validateChallenge({
    schema: 'agoragentic.agent-payments-assurance-challenge.v1',
    scenarios: [{ scenario_id: 'bad', expected_decision: 'guess' }],
  }), /unsupported expected decision/);
});
