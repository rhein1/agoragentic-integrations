import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  RUNPAY_PROFILE_ID, RUNPAY_PROFILE_DIGEST,
  RunpayImportError, parseRunpayJson, normalizeRunpayRecord, normalizeRunpayBatch,
  renderRunpayReport,
} from './runpay-catalog.mjs';
import { LIMITS } from './runpay-json.mjs';

const fail = (code) => { throw new RunpayImportError(code); };
const HELP = `run.pay offline evidence importer — local only
agora-assure runpay import <fixture.json> --out <dir> --namespace <ns>
  [--profile ${RUNPAY_PROFILE_ID}] [--history <envelopes.json>]
  [--fail-on unresolved|contradicted|unsupported]
Writes runpay-records.json and runpay-records.sha256 into <dir> (created if
missing; existing files are never overwritten). Human report goes to stderr.
Fixture basis: vendor-supplied records from ${'https://github.com/rhein1/agoragentic-integrations/issues/376'}.
The catalog endpoint is provenance only and is never fetched. Nothing here
verifies run.pay data, settles payment, or implies production readiness.
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
    if (error instanceof RunpayImportError) throw error;
    fail('input_read_failed');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function detectRawKind(input) {
  if (input && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, 'schema')) return 'envelope';
  if (Array.isArray(input)) return 'catalog_service';
  if (input && typeof input === 'object') {
    if (Array.isArray(input.services)) return 'catalog_service';
    if (input.chain && typeof input.chain === 'object') return 'observability_record';
  }
  fail('unrecognized_fixture');
}

function wrapEnvelope(raw, kind, namespace) {
  const recordRaw = kind === 'catalog_service'
    ? (Array.isArray(raw) ? raw : raw.services)
    : raw;
  return {
    schema: 'agoragentic.runpay-catalog.v1',
    source: { provider: 'runpay', namespace, record_kind: kind, schema_revision: '2026-09-09' },
    profile_id: RUNPAY_PROFILE_ID, profile_digest: RUNPAY_PROFILE_DIGEST,
    record: { raw: recordRaw },
  };
}

export function runpayExitCode(records, selected = []) {
  const states = new Set(records.map((record) => record.assessment.overall_evidence_status));
  if (selected.includes('contradicted') && states.has('contradicted')) return 3;
  if (selected.includes('unsupported') && states.has('unsupported')) return 4;
  if (selected.includes('unresolved') && states.has('unresolved')) return 2;
  return 0;
}

export function runRunpayCLI(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) { io.stdout.write(HELP); return 0; }
    if (argv[0] !== 'import') fail('invalid_command');
    const positional = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
    if (!positional) fail('invalid_arguments');
    const options = Object.create(null); const selected = [];
    for (let i = 2; i < argv.length; i += 2) {
      const key = argv[i]; const value = argv[i + 1];
      if (!['--out', '--namespace', '--profile', '--history', '--fail-on'].includes(key) || !value || value.startsWith('--')) fail('invalid_arguments');
      if (key === '--fail-on') {
        if (!['unresolved', 'contradicted', 'unsupported'].includes(value)) fail('invalid_arguments');
        selected.push(value);
      } else {
        if (Object.hasOwn(options, key)) fail('invalid_arguments');
        options[key] = value;
      }
    }
    if (!options['--out'] || !options['--namespace']) fail('invalid_arguments');
    const profileId = options['--profile'] ?? RUNPAY_PROFILE_ID;
    const inputBytes = readBounded(positional, LIMITS.bytes);
    const input = parseRunpayJson(inputBytes);
    let batch;
    if (detectRawKind(input) === 'envelope') {
      const envelope = input;
      if (envelope.profile_id !== profileId) fail('profile_id_mismatch');
      if (envelope.source?.namespace !== options['--namespace']) fail('namespace_mismatch');
      if (options['--history']) fail('ambiguous_history');
      batch = Array.isArray(envelope.record.raw)
        ? normalizeRunpayBatch(envelope)
        : { schema: 'agoragentic.runpay-evidence-batch.v1', records: [normalizeRunpayRecord(envelope)] };
    } else {
      if (profileId !== RUNPAY_PROFILE_ID) fail('unsupported_profile');
      const kind = detectRawKind(input);
      const envelope = wrapEnvelope(input, kind, options['--namespace']);
      if (options['--history']) {
        if (kind !== 'catalog_service') fail('invalid_arguments');
        envelope.history = parseRunpayJson(readBounded(options['--history'], LIMITS.bytes - inputBytes.length));
      }
      batch = Array.isArray(envelope.record.raw)
        ? normalizeRunpayBatch(envelope)
        : { schema: 'agoragentic.runpay-evidence-batch.v1', records: [normalizeRunpayRecord(envelope)] };
    }
    const json = JSON.stringify(batch, null, 2) + '\n';
    fs.mkdirSync(options['--out'], { recursive: true });
    const recordsPath = path.join(options['--out'], 'runpay-records.json');
    const digestPath = path.join(options['--out'], 'runpay-records.sha256');
    try {
      fs.writeFileSync(recordsPath, json, { flag: 'wx', mode: 0o600 });
    } catch { fail('output_write_failed'); }
    const digest = `sha256:${createHash('sha256').update(json, 'utf8').digest('hex')}\n`;
    try {
      fs.writeFileSync(digestPath, digest, { flag: 'wx', mode: 0o600 });
    } catch { fail('output_write_failed'); }
    io.stderr.write(batch.records.map(renderRunpayReport).join('\n'));
    return runpayExitCode(batch.records, selected);
  } catch (error) {
    const code = error instanceof RunpayImportError ? error.code : 'internal_error';
    io.stderr.write(JSON.stringify({ schema: 'agoragentic.runpay-import-error.v1', code, retryable: false }) + '\n');
    return code === 'internal_error' ? 70 : 64;
  }
}
