import assert from 'node:assert/strict';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DemoSecurityError,
  RISK_FORK_DEMO_BANNER,
  RISK_FORK_DEMO_LIMITS,
  RISK_FORK_DEMO_ROOT_MARKER,
  RISK_FORK_DEMO_TRUTH_FIELDS,
  assertDemoSecretFree,
  assertDemoTruth,
  createDemoTruth,
  initializeOwnedDemoRoot,
  inspectOwnedDemoTree,
  normalizeDemoRelativePath,
  openOwnedDemoRoot,
  redactDemoValue,
  removeOwnedDemoEntry,
  resolveOwnedDemoPath,
  sanitizeDemoError,
  scanDemoSecrets,
  validateDemoOperation,
} from '../src/security.mjs';

const FIXED_NOW = new Date('2030-01-01T00:00:00.000Z');
const FIXED_ENTROPY = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

async function temporaryRoot(prefix = 'risk-fork-hackathon-security-') {
  const parent = await mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(parent, 'agoragentic-risk-fork-demo-root');
  const handle = await initializeOwnedDemoRoot(root, {
    clock: () => FIXED_NOW,
    randomBytesFn: () => Buffer.from(FIXED_ENTROPY),
  });
  return { parent, root, handle };
}

async function cleanupTemporary(parent) {
  await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}

test('demo truth is exact, immutable, and cannot be weakened', () => {
  const result = createDemoTruth({ scenario_id: 'scenario:low-direct' });
  assert.equal(result.banner, RISK_FORK_DEMO_BANNER);
  assert.deepEqual(
    Object.fromEntries(Object.keys(RISK_FORK_DEMO_TRUTH_FIELDS).map((key) => [key, result[key]])),
    RISK_FORK_DEMO_TRUTH_FIELDS,
  );
  assert.equal(assertDemoTruth(result), true);
  assert.ok(Object.isFrozen(result));
  assert.throws(
    () => createDemoTruth({ production_ready: true }),
    (error) => error instanceof DemoSecurityError && error.code === 'DEMO_TRUTH_OVERRIDE',
  );
  assert.throws(
    () => assertDemoTruth({ ...result, authority_granted: true }),
    (error) => error instanceof DemoSecurityError && error.code === 'DEMO_TRUTH_INVALID',
  );
});

test('secret scanning and redaction never echo synthetic secret material', () => {
  const synthetic = `amk_${'a'.repeat(64)}`;
  const input = {
    note: `prefix-${synthetic}-suffix`,
    apiKey: 'not-returned',
    authority_granted: false,
    authority_flags: { can_spend: false },
    execution_authorization: null,
  };
  const scan = scanDemoSecrets(input);
  assert.equal(scan.safe, false);
  assert.doesNotMatch(JSON.stringify(scan), new RegExp(synthetic));
  assert.throws(() => assertDemoSecretFree(input), (error) => {
    assert.equal(error.code, 'DEMO_SECRET_SHAPED_INPUT');
    assert.equal(error.message.includes(synthetic), false);
    assert.equal(JSON.stringify(error.details).includes(synthetic), false);
    return true;
  });
  const redacted = redactDemoValue(input);
  assert.equal(JSON.stringify(redacted).includes(synthetic), false);
  assert.match(JSON.stringify(redacted), /REDACTED_SECRET/);
  const sanitized = sanitizeDemoError(new Error(`failed with ${synthetic}`));
  assert.equal(JSON.stringify(sanitized).includes(synthetic), false);
  assert.equal(sanitized.message, 'Demo operation failed');
  assert.equal(
    assertDemoSecretFree({
      authority_granted: false,
      credentials_used: false,
      authority_flags: { can_spend: false },
      execution_authorization: null,
      authorization_hash: `sha256:${'b'.repeat(64)}`,
    }),
    true,
  );
});

test('credential-bearing field families are rejected and redacted without weakening safe authority metadata', () => {
  const values = {
    token: 'synthetic-token-material-1234567890',
    authorization: 'synthetic-authorization-material-1234567890',
    session_cookie: 'synthetic-cookie-material-1234567890',
    E2B_API_KEY: 'synthetic-provider-key-material-1234567890',
    provider_access_token: 'synthetic-access-material-1234567890',
    provider_private_key: 'synthetic-private-material-1234567890',
    provider_signing_secret: 'synthetic-signing-material-1234567890',
    wallet_seed: 'synthetic-wallet-material-1234567890',
    recovery_phrase: 'synthetic-recovery-material-1234567890',
  };
  const serializedValues = Object.values(values);
  const scan = scanDemoSecrets(values);
  assert.equal(scan.safe, false);
  assert.deepEqual([...new Set(scan.findings.map((finding) => finding.code))], ['secret_field']);
  for (const value of serializedValues) assert.equal(JSON.stringify(scan).includes(value), false);
  assert.throws(() => assertDemoSecretFree(values), (error) => {
    assert.equal(error.code, 'DEMO_SECRET_SHAPED_INPUT');
    for (const value of serializedValues) {
      assert.equal(error.message.includes(value), false);
      assert.equal(JSON.stringify(error.details).includes(value), false);
    }
    return true;
  });
  const redacted = redactDemoValue(values);
  for (const value of serializedValues) assert.equal(JSON.stringify(redacted).includes(value), false);
  assert.equal(Object.keys(redacted).every((key) => /^\[REDACTED_FIELD_\d+\]$/.test(key)), true);

  const safeMetadata = {
    authority_granted: false,
    authority_flags: { can_spend: false },
    execution_authorization: null,
    authorization_hash: `sha256:${'a'.repeat(64)}`,
    provider_authorization_ref: 'authorization:synthetic-demo',
    provider_authorization_hash: `sha256:${'b'.repeat(64)}`,
    one_use_authorization_id: 'one-use:synthetic-demo',
    credentials_used: false,
    credential_revocation_claim: { status: 'not_applicable' },
    token_redacted: true,
  };
  assert.equal(scanDemoSecrets(safeMetadata).safe, true);
  assert.equal(assertDemoSecretFree(safeMetadata), true);

  for (const fieldName of [
    'provider_token_authorization_id',
    'api_key_authorization_ref',
    'password_authority_status',
  ]) {
    const unsafeMetadata = { [fieldName]: 'synthetic-opaque-value' };
    const unsafeScan = scanDemoSecrets(unsafeMetadata);
    assert.equal(unsafeScan.safe, false, fieldName);
    assert.deepEqual(unsafeScan.findings.map((finding) => finding.code), ['secret_field']);
    assert.equal(JSON.stringify(unsafeScan).includes(fieldName), false);
    assert.deepEqual(Object.keys(redactDemoValue(unsafeMetadata)), ['[REDACTED_FIELD_1]']);
  }
});

test('private absolute paths are rejected before truth persistence and redacted without echo', () => {
  const privatePaths = [
    String.raw`C:\Users\Alice\private.txt`,
    String.raw`D:\vault\private.txt`,
    String.raw`\\server\share\private.txt`,
    'file:///C:/Users/Alice/private.txt',
    '/home/alice/private.txt',
    '/root/private.txt',
    '/Users/alice/private.txt',
    '/tmp/private-demo/private.txt',
    '/opt/private-demo/private.txt',
    '//server/share/private.txt',
  ];
  for (const privatePath of privatePaths) {
    const input = { location: privatePath };
    const scan = scanDemoSecrets(input);
    assert.equal(scan.safe, false, privatePath);
    assert.equal(scan.findings.some((finding) => finding.code === 'private_absolute_path'), true);
    assert.equal(JSON.stringify(scan).includes(privatePath), false);
    assert.throws(() => createDemoTruth(input), (error) => {
      assert.equal(error.code, 'DEMO_SECRET_SHAPED_INPUT');
      assert.equal(error.message.includes(privatePath), false);
      assert.equal(JSON.stringify(error.details).includes(privatePath), false);
      return true;
    });
    const redacted = redactDemoValue(input);
    assert.equal(JSON.stringify(redacted).includes(privatePath), false);
    assert.match(redacted.location, /REDACTED_PRIVATE_PATH/);
  }

  const approvedEntrypoints = [
    String.raw`C:\projects\demo\risk-fork\hackathon\bin\risk-fork-demo.mjs`,
    '/opt/risk-fork/hackathon/bin/risk-fork-demo.mjs',
  ];
  for (const approvedEntrypoint of approvedEntrypoints) {
    assert.equal(scanDemoSecrets({ entrypoint: approvedEntrypoint }).safe, false);
    assert.throws(() => createDemoTruth({ entrypoint: approvedEntrypoint }), {
      code: 'DEMO_SECRET_SHAPED_INPUT',
    });
    assert.equal(
      scanDemoSecrets(
        { entrypoint: approvedEntrypoint },
        { allowedAbsolutePaths: [approvedEntrypoint] },
      ).safe,
      true,
    );
    assert.equal(
      scanDemoSecrets(
        JSON.stringify({ entrypoint: approvedEntrypoint }),
        { allowedAbsolutePaths: [approvedEntrypoint] },
      ).safe,
      true,
    );
    assert.equal(
      redactDemoValue({ entrypoint: approvedEntrypoint }).entrypoint,
      '[REDACTED_PRIVATE_PATH]',
    );
    assert.equal(
      scanDemoSecrets(
        { [approvedEntrypoint]: 'opaque' },
        { allowedAbsolutePaths: [approvedEntrypoint] },
      ).safe,
      false,
    );
    const serializedKey = JSON.stringify({ [approvedEntrypoint]: 'opaque' });
    assert.equal(
      scanDemoSecrets(serializedKey, { allowedAbsolutePaths: [approvedEntrypoint] }).safe,
      false,
    );
    assert.equal(redactDemoValue(serializedKey).includes(approvedEntrypoint), false);
  }

  const [approvedWindowsEntrypoint, approvedPosixEntrypoint] = approvedEntrypoints;
  for (const nearOrDifferentPath of [
    String.raw`D:\projects\demo\risk-fork\hackathon\bin\risk-fork-demo.mjs`,
    `${approvedWindowsEntrypoint}.backup`,
    `${approvedWindowsEntrypoint}\\child`,
    `${approvedWindowsEntrypoint}\\..\\private.mjs`,
    '/srv/risk-fork/hackathon/bin/risk-fork-demo.mjs',
    `${approvedPosixEntrypoint}.backup`,
    `${approvedPosixEntrypoint}/child`,
    `${approvedPosixEntrypoint}/../private.mjs`,
  ]) {
    const allowedAbsolutePaths = nearOrDifferentPath.includes('\\')
      ? [approvedWindowsEntrypoint]
      : [approvedPosixEntrypoint];
    assert.equal(
      scanDemoSecrets({ entrypoint: nearOrDifferentPath }, { allowedAbsolutePaths }).safe,
      false,
      nearOrDifferentPath,
    );
    const redacted = redactDemoValue({ entrypoint: nearOrDifferentPath });
    assert.equal(JSON.stringify(redacted).includes(nearOrDifferentPath), false);
    assert.equal(redacted.entrypoint, '[REDACTED_PRIVATE_PATH]');
  }
  assert.equal(
    scanDemoSecrets(
      JSON.stringify({
        args: [approvedPosixEntrypoint, 'mcp'],
        private_location: '/home/alice/private.txt',
      }),
      { allowedAbsolutePaths: [approvedPosixEntrypoint] },
    ).safe,
    false,
  );
  for (const invalidAllowedPath of [
    '/opt/risk-fork/../private.mjs',
    String.raw`C:\projects\risk-fork\..\private.mjs`,
    'file:///opt/risk-fork/hackathon/bin/risk-fork-demo.mjs',
  ]) {
    assert.throws(
      () => scanDemoSecrets('relative-safe-value', { allowedAbsolutePaths: [invalidAllowedPath] }),
      (error) => {
        assert.equal(error.code, 'DEMO_ALLOWED_ABSOLUTE_PATH_INVALID');
        assert.equal(error.message.includes(invalidAllowedPath), false);
        return true;
      },
    );
  }
  assert.throws(
    () => scanDemoSecrets('relative-safe-value', {
      allowedAbsolutePaths: ['/a', '/b', '/c', '/d', '/e'],
    }),
    { code: 'DEMO_ALLOWED_ABSOLUTE_PATH_INVALID' },
  );

  const privateKey = '/tmp/private-demo/object-key';
  const keyScan = scanDemoSecrets({ [privateKey]: 'opaque' });
  assert.equal(keyScan.safe, false);
  assert.equal(JSON.stringify(keyScan).includes(privateKey), false);
  assert.deepEqual(Object.keys(redactDemoValue({ [privateKey]: 'opaque' })), ['[REDACTED_FIELD_1]']);

  const safeReferences = {
    launch_url: 'https://synthetic-risk-fork.invalid/api/records',
    receipt_ref: `record:sha256:${'a'.repeat(64)}`,
    relative_path: 'sessions/run-1/result.json',
  };
  assert.equal(scanDemoSecrets(safeReferences).safe, true);
  assert.deepEqual(redactDemoValue(safeReferences), safeReferences);

  const privateErrorPath = '/opt/private-demo/failure.txt';
  const sanitized = sanitizeDemoError(new Error(`failed at ${privateErrorPath}`));
  assert.equal(sanitized.message.includes(privateErrorPath), false);
  assert.match(sanitized.message, /REDACTED_PRIVATE_PATH/);

  const syntheticPosixPath = '/synthetic/private/demo.txt';
  for (const embedded of [
    `[${syntheticPosixPath}]`,
    `{${syntheticPosixPath}}`,
    `path:${syntheticPosixPath}`,
    `path>${syntheticPosixPath}`,
    `path|${syntheticPosixPath}|`,
  ]) {
    const embeddedScan = scanDemoSecrets({ note: embedded });
    assert.equal(embeddedScan.safe, false, embedded);
    assert.equal(JSON.stringify(embeddedScan).includes(syntheticPosixPath), false);
    assert.throws(() => createDemoTruth({ note: embedded }), (error) => {
      assert.equal(error.code, 'DEMO_SECRET_SHAPED_INPUT');
      assert.equal(error.message.includes(syntheticPosixPath), false);
      assert.equal(JSON.stringify(error.details).includes(syntheticPosixPath), false);
      return true;
    });
    const embeddedRedacted = redactDemoValue({ note: embedded });
    assert.equal(embeddedRedacted.note.includes(syntheticPosixPath), false);
    assert.match(embeddedRedacted.note, /REDACTED_PRIVATE_PATH/);
    const embeddedError = sanitizeDemoError(new Error(embedded));
    assert.equal(embeddedError.message.includes(syntheticPosixPath), false);
    assert.match(embeddedError.message, /REDACTED_PRIVATE_PATH/);
  }

  for (const safeReference of [
    'https://synthetic-risk-fork.invalid/api/records',
    'http://127.0.0.1:1234/api/records',
    'sessions/run-1/result.json',
  ]) {
    assert.equal(scanDemoSecrets({ safe_reference: safeReference }).safe, true);
    assert.equal(redactDemoValue({ safe_reference: safeReference }).safe_reference, safeReference);
  }
});

test('relative path normalization rejects traversal and Windows aliases', () => {
  assert.equal(normalizeDemoRelativePath('sessions/run-1/result.json'), 'sessions/run-1/result.json');
  for (const candidate of [
    '../outside.txt',
    '/absolute.txt',
    'C:/outside.txt',
    'sessions\\run.txt',
    'sessions/./run.txt',
    'sessions/file.txt:stream',
    'sessions/CON.txt',
    'sessions/trailing. ',
    '.git/config',
    `sessions/cafe\u0301.txt`,
  ]) {
    assert.throws(
      () => normalizeDemoRelativePath(candidate),
      (error) => error instanceof DemoSecurityError && error.code === 'DEMO_PATH_INVALID',
      candidate,
    );
  }
});

test('strict operation validation enforces action, write, secret, and alias limits', () => {
  const operation = validateDemoOperation({
    kind: 'bounded_file_batch',
    actions: [{ type: 'write', path: 'workspace/result.txt', content: 'prepared' }],
    commit_candidate: null,
  });
  assert.equal(operation.actions.length, 1);
  assert.equal(operation.actions[0].content, 'prepared');
  assert.throws(
    () => validateDemoOperation({
      kind: 'bounded_file_batch',
      actions: Array.from({ length: RISK_FORK_DEMO_LIMITS.max_actions + 1 }, (_, index) => ({
        type: 'read',
        path: `workspace/file-${index}.txt`,
      })),
    }),
    (error) => error.code === 'DEMO_ACTION_LIMIT',
  );
  assert.throws(
    () => validateDemoOperation({
      kind: 'bounded_file_batch',
      actions: [{
        type: 'write',
        path: 'workspace/large.txt',
        content: 'x'.repeat(RISK_FORK_DEMO_LIMITS.max_write_bytes + 1),
      }],
    }),
    (error) => error.code === 'DEMO_WRITE_LIMIT',
  );
  assert.throws(
    () => validateDemoOperation({
      kind: 'bounded_file_batch',
      actions: [
        { type: 'read', path: 'workspace/A.txt' },
        { type: 'read', path: 'workspace/a.txt' },
      ],
    }),
    (error) => error.code === 'DEMO_PATH_COLLISION',
  );
  const synthetic = `Bearer ${'z'.repeat(32)}`;
  assert.throws(
    () => validateDemoOperation({
      kind: 'bounded_file_batch',
      actions: [{ type: 'write', path: 'workspace/secret.txt', content: synthetic }],
    }),
    (error) => {
      assert.equal(error.message.includes(synthetic), false);
      return true;
    },
  );
});

test('owned root marker binds child resolution, inventory, quota, and cleanup', async () => {
  const fixture = await temporaryRoot();
  const outside = path.join(fixture.parent, 'outside-sentinel.txt');
  try {
    await writeFile(outside, 'outside', 'utf8');
    const reopened = await openOwnedDemoRoot(fixture.root);
    assert.deepEqual(reopened, fixture.handle);
    assert.match(reopened.root_id, /^demo-root-[a-f0-9]{32}$/);
    assert.equal(
      JSON.parse(await readFile(path.join(fixture.root, RISK_FORK_DEMO_ROOT_MARKER), 'utf8')).created_at,
      FIXED_NOW.toISOString(),
    );
    const session = await resolveOwnedDemoPath(fixture.handle, 'sessions/run-1', { mustExist: false });
    await mkdir(session.absolute_path, { recursive: true });
    await writeFile(path.join(session.absolute_path, 'result.json'), '{}', 'utf8');
    const result = await resolveOwnedDemoPath(fixture.handle, 'sessions/run-1/result.json', {
      mustExist: true,
      expectedType: 'file',
    });
    assert.equal(result.type, 'file');
    const inventory = await inspectOwnedDemoTree(fixture.handle);
    assert.equal(inventory.file_count, 1);
    assert.equal(inventory.directory_count, 2);
    assert.deepEqual(inventory.entries.map((entry) => entry.path), [
      'sessions',
      'sessions/run-1',
      'sessions/run-1/result.json',
    ]);
    await assert.rejects(
      inspectOwnedDemoTree(fixture.handle, { maxBytes: 1 }),
      (error) => error.code === 'DEMO_BYTE_LIMIT',
    );
    assert.deepEqual(await removeOwnedDemoEntry(fixture.handle, 'sessions/run-1'), {
      status: 'verified_absent',
      relative_path: 'sessions/run-1',
      removed: true,
    });
    assert.deepEqual(await removeOwnedDemoEntry(fixture.handle, 'sessions/run-1'), {
      status: 'verified_absent',
      relative_path: 'sessions/run-1',
      removed: false,
    });
    assert.equal(await readFile(outside, 'utf8'), 'outside');
  } finally {
    await cleanupTemporary(fixture.parent);
  }
});

test('unmarked nonempty roots and marker tampering fail closed', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-hackathon-unowned-'));
  const root = path.join(parent, 'agoragentic-risk-fork-demo-root');
  try {
    await mkdir(root);
    await writeFile(path.join(root, 'sentinel.txt'), 'keep', 'utf8');
    await assert.rejects(
      initializeOwnedDemoRoot(root),
      (error) => error.code === 'DEMO_ROOT_NOT_OWNED',
    );
    assert.equal(await readFile(path.join(root, 'sentinel.txt'), 'utf8'), 'keep');
    await rm(path.join(root, 'sentinel.txt'));
    const handle = await initializeOwnedDemoRoot(root);
    const markerPath = path.join(root, RISK_FORK_DEMO_ROOT_MARKER);
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    marker.root_path_hash = `sha256:${'0'.repeat(64)}`;
    await writeFile(markerPath, JSON.stringify(marker), 'utf8');
    await assert.rejects(openOwnedDemoRoot(root), (error) => error.code === 'DEMO_ROOT_MARKER_INVALID');
    assert.ok(handle.root_id);
  } finally {
    await cleanupTemporary(parent);
  }
});

test('owned child resolution rejects hard links and symlink or junction traversal', async (t) => {
  const fixture = await temporaryRoot('risk-fork-hackathon-links-');
  const outside = path.join(fixture.parent, 'outside.txt');
  try {
    await writeFile(outside, 'outside', 'utf8');
    const hard = await resolveOwnedDemoPath(fixture.handle, 'hard.txt');
    await link(outside, hard.absolute_path);
    await assert.rejects(
      resolveOwnedDemoPath(fixture.handle, 'hard.txt', { mustExist: true }),
      (error) => error.code === 'DEMO_PATH_UNSAFE',
    );

    const realDirectory = path.join(fixture.parent, 'real-directory');
    const linkedDirectory = path.join(fixture.root, 'linked-directory');
    await mkdir(realDirectory);
    let linked = true;
    try {
      await symlink(realDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error;
      linked = false;
      t.diagnostic('directory symlink/junction creation is unavailable on this host');
    }
    if (linked) {
      await assert.rejects(
        resolveOwnedDemoPath(fixture.handle, 'linked-directory/escape.txt'),
        (error) => error.code === 'DEMO_PATH_UNSAFE',
      );
    }
    assert.equal(await readFile(outside, 'utf8'), 'outside');
  } finally {
    await cleanupTemporary(fixture.parent);
  }
});
