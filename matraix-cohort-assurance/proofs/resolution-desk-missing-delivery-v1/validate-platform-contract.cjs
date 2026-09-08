'use strict';

const fs = require('node:fs');
const path = require('node:path');

const expected = require('./platform-contract.json');
const marketplaceRoot = path.resolve(process.argv[2] || '');
if (!marketplaceRoot || !fs.existsSync(marketplaceRoot)) throw new Error('marketplace checkout path is required');
const validator = require(path.join(marketplaceRoot, expected.validator_module));
const evidence = JSON.parse(fs.readFileSync(path.join(__dirname, 'synthetic-cohort-evidence.json'), 'utf8'));
const result = validator.validateSyntheticCohortEvidence(evidence);
if (!result.structural_valid || !result.claim_eligible || !result.valid) {
    throw new Error(`platform contract rejected fixture evidence: ${JSON.stringify(result.findings)}`);
}
for (const requirement of [
    { evidence_class: 'human_subject_observation' },
    { evidence_class: 'affected_community_participation' },
    { evidence_class: 'authorized_representation' },
    { evidence_class: 'production_outcome' },
    { claim: 'human_preference' },
]) {
    if (validator.evidenceSatisfiesRequirement(evidence, requirement).eligible) {
        throw new Error(`platform contract granted prohibited eligibility: ${JSON.stringify(requirement)}`);
    }
}
process.stdout.write(`platform contract ${expected.source_commit} accepted offline fixture evidence only\n`);
