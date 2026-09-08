'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { canonicalize, stable } = require('./canonical-evidence.cjs');
const pin = require('./platform-contract.json');
const evidence = JSON.parse(fs.readFileSync(path.join(__dirname, 'synthetic-cohort-evidence.json'), 'utf8'));

execFileSync('python', [path.join(__dirname, 'validate_platform_schema.py')], { stdio: 'inherit', timeout: 30000 });
if (stable(evidence) !== stable(canonicalize(evidence))) throw new Error('canonical evidence identity mismatch');
process.stdout.write('Canonical evidence identity valid; fixture authenticity is not established\n');

const args = process.argv.slice(2);
if (args.length) {
    if (args.length !== 2 || args[0] !== '--platform-root') throw new Error('usage: --platform-root <exact clean checkout>');
    const root = path.resolve(args[1]);
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (head !== pin.source_commit) throw new Error('platform checkout commit mismatch');
    if (execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('platform checkout must be clean');
    const validator = require(path.join(root, 'server/modules/synthetic-cohort-evidence.js'));
    const result = validator.validateSyntheticCohortEvidence(evidence);
    if (!result.valid || result.findings.length) throw new Error('platform semantic validation failed');
    process.stdout.write(`Platform semantic validator passed at ${head}; offline fixtures only\n`);
}
