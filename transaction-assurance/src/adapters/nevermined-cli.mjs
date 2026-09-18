import fs from 'node:fs';
import {
  NEVERMINED_PROFILE_ID, NEVERMINED_PROFILE_DIGEST, NEVERMINED_REVISION,
  NeverminedImportError, parseNeverminedJson, normalizeNeverminedExport,
  renderNeverminedReport,
} from './nevermined-ledger.mjs';
import { LIMITS } from './nevermined-json.mjs';

const fail = (code) => { throw new NeverminedImportError(code); };
const HELP = `Nevermined evidence importer — Stage A, local only
agora-assure nevermined import --input ledger.json --profile ${NEVERMINED_PROFILE_ID}
  [--namespace sandbox:example] [--history envelopes.json] [--output evidence.json]
  [--fail-on unresolved|contradicted|unsupported ...]
Use --namespace with a raw record/array. Wrapped imports declare their own namespace.
History is an array of raw import envelopes, not previously claimed verification results.
JSON goes to stdout, or a NEW file at --output. Human report goes to stderr.
Profile basis: vendor documentation, not a real export. Stage B remains gated.
`;

function readBounded(file, budget) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) fail('invalid_input_file');
    if (stat.size > budget) fail('input_too_large');
    // Cap the actual read too: the file may change after fstat.
    const buffer = Buffer.alloc(budget + 1);
    let size = 0; let n;
    do { n = fs.readSync(fd, buffer, size, buffer.length - size, null); size += n; }
    while (n && size < buffer.length);
    if (size > budget) fail('input_too_large');
    return buffer.subarray(0, size);
  } catch (error) {
    if (error instanceof NeverminedImportError) throw error;
    fail('input_read_failed');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function neverminedExitCode(records, selected = []) {
  const states = new Set(records.map((record) => record.assessment.overall_evidence_status));
  if (selected.includes('contradicted') && states.has('contradicted')) return 3;
  if (selected.includes('unsupported') && states.has('unsupported')) return 4;
  if (selected.includes('unresolved') && states.has('unresolved')) return 2;
  return 0;
}

export function runNeverminedCLI(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) { io.stdout.write(HELP); return 0; }
    if (argv[0] === 'attach-settlement') fail('stage_b_gated');
    if (argv[0] !== 'import') fail('invalid_command');
    const options = Object.create(null); const selected = [];
    for (let i = 1; i < argv.length; i += 2) {
      const key = argv[i]; const value = argv[i + 1];
      if (!['--input', '--profile', '--namespace', '--output', '--history', '--fail-on'].includes(key) || !value || value.startsWith('--')) fail('invalid_arguments');
      if (key === '--fail-on') {
        if (!['unresolved', 'contradicted', 'unsupported'].includes(value)) fail('invalid_arguments');
        selected.push(value);
      } else {
        if (Object.hasOwn(options, key)) fail('invalid_arguments');
        options[key] = value;
      }
    }
    if (!options['--input'] || !options['--profile']) fail('invalid_arguments');
    const inputBytes = readBounded(options['--input'], LIMITS.bytes);
    const input = parseNeverminedJson(inputBytes);
    let envelope;
    if (input && !Array.isArray(input) && Object.hasOwn(input, 'schema')) {
      envelope = input;
      if (envelope.profile_id !== options['--profile']) fail('profile_id_mismatch');
      if (options['--namespace'] && options['--namespace'] !== envelope.source?.namespace) fail('namespace_mismatch');
    } else {
      if (!options['--namespace']) fail('namespace_required');
      if (options['--profile'] !== NEVERMINED_PROFILE_ID) fail('unsupported_profile');
      envelope = {
        schema: 'agoragentic.nevermined-import.v1',
        source: { provider: 'nevermined', namespace: options['--namespace'], record_kind: 'merchant_payment_ledger', schema_revision: NEVERMINED_REVISION },
        profile_id: NEVERMINED_PROFILE_ID, profile_digest: NEVERMINED_PROFILE_DIGEST,
        record: { raw: input },
      };
    }
    if (options['--history']) {
      if (Object.hasOwn(envelope, 'history')) fail('ambiguous_history');
      envelope.history = parseNeverminedJson(readBounded(options['--history'], LIMITS.bytes - inputBytes.length));
    }
    const report = normalizeNeverminedExport(envelope);
    const json = JSON.stringify(report, null, 2) + '\n';
    if (options['--output']) {
      // Never overwrite an existing artifact, input, credential file, or symlink.
      try { fs.writeFileSync(options['--output'], json, { flag: 'wx', mode: 0o600 }); }
      catch { fail('output_write_failed'); }
    } else io.stdout.write(json);
    io.stderr.write(report.records.map(renderNeverminedReport).join('\n'));
    return neverminedExitCode(report.records, selected);
  } catch (error) {
    const code = error instanceof NeverminedImportError ? error.code : 'internal_error';
    io.stderr.write(JSON.stringify({ schema: 'agoragentic.nevermined-import-error.v1', code, retryable: false }) + '\n');
    return code === 'internal_error' ? 70 : 64;
  }
}
