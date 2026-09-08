'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
// agoragentic-canonical-json-v1 uses JavaScript number/string serialization.
// Serialization only; platform eligibility rules remain platform-owned.
function stable(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}
function canonicalize(input) {
    const value = JSON.parse(JSON.stringify(input));
    if (!value || typeof value !== 'object' || !value.artifacts) throw new Error('evidence object required');
    delete value.evidence_id;
    delete value.artifacts.canonical_evidence_sha256;
    const digest = crypto.createHash('sha256').update(stable(value)).digest('hex');
    value.evidence_id = `sce_${digest.slice(0, 24)}`;
    value.artifacts.canonical_evidence_sha256 = `sha256:${digest}`;
    return value;
}
module.exports = { canonicalize, stable };
if (require.main === module) {
    const bytes = fs.readFileSync(0);
    if (bytes.length > 262144) throw new Error('evidence input too large');
    process.stdout.write(`${stable(canonicalize(JSON.parse(bytes.toString('utf8'))))}\n`);
}
