'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const expected = require('./platform-contract.json');
const schemaPath = path.join(__dirname, 'synthetic-cohort-evidence.v1.snapshot.json');
const schemaBytes = fs.readFileSync(schemaPath);
const schemaDigest = `sha256:${crypto.createHash('sha256').update(schemaBytes).digest('hex')}`;
if (schemaDigest !== expected.schema_sha256) throw new Error(`platform schema snapshot digest mismatch: ${schemaDigest}`);
const schema = JSON.parse(schemaBytes);
const evidence = JSON.parse(fs.readFileSync(path.join(__dirname, 'synthetic-cohort-evidence.json'), 'utf8'));
if (schema.$id !== expected.schema_uri || evidence.schema !== expected.schema) throw new Error('platform schema identity mismatch');
if (evidence.evidence_class !== 'synthetic_behavioral' || evidence.status !== 'experimental_advisory') throw new Error('synthetic evidence classification drift');
if (evidence.models.persona_models.length !== 2) throw new Error('both fixture persona backbones must be bound');
if (!evidence.limitations.includes('no_live_model_trials')) throw new Error('fixture-only limitation is required');
const terminalTrials = ['trials_completed', 'trials_failed', 'trials_timed_out', 'trials_abandoned', 'trials_invalid', 'trials_unverifiable'].reduce((total, key) => total + evidence.run[key], 0);
if (evidence.run.trials_requested !== 32 || evidence.run.trials_started !== 32 || terminalTrials !== 32) throw new Error('fixture run accounting drift');
if (evidence.claim_scope.unsupported.length !== 12 || !evidence.claim_scope.unsupported.includes('human_preference')) throw new Error('prohibited claim scope drift');
for (const [key, value] of Object.entries(evidence.authority_boundary)) {
    if (key === 'evidence_is_advisory' ? value !== true : value !== false) throw new Error(`authority boundary drift: ${key}`);
}
for (const key of ['synthetic_personas_speak_for_real_people', 'human_participant_substitution', 'affected_community_authorization_claimed', 'representational_legitimacy_claimed', 'human_preference_inference_claimed', 'population_inference_claimed', 'market_demand_inference_claimed']) {
    if (evidence.representation_boundary[key] !== false) throw new Error(`representation boundary drift: ${key}`);
}
process.stdout.write(`pinned platform contract ${expected.source_commit} accepts offline fixture evidence only\n`);
