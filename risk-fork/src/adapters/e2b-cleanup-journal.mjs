import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import { sha256Ref } from '../canonical.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  cloneJson,
  deepFreeze,
  requireEnum,
  requireIsoDate,
  requireOpaqueRef,
  requireSha256Ref,
  requireString,
  safeEqual,
} from '../util.mjs';

const JOURNAL_SCHEMA = 'agoragentic.risk-fork.e2b-cleanup-journal.v1';
const SANDBOX_STATES = Object.freeze([
  'not_requested',
  'allocation_requested',
  'allocated',
  'destroy_requested',
  'verified_absent',
  'unknown',
]);
const EXPORT_STATES = Object.freeze([
  'creating',
  'active',
  'destroy_requested',
  'verified_absent',
  'unknown',
]);

function requireNullableString(value, field, { maxLength = 1_024 } = {}) {
  if (value === null) return null;
  return requireString(value, field, { maxLength });
}

function requireNullableSha256(value, field) {
  if (value === null) return null;
  return requireSha256Ref(value, field);
}

function normalizeRecord(value) {
  assertPlainObject(value, 'E2B cleanup journal record');
  assertAllowedKeys(value, [
    'schema',
    'record_id',
    'cleanup_ref',
    'provider_id',
    'template_id_hash',
    'metadata_hash',
    'export_id',
    'export_manifest_hash',
    'export_workspace_digest',
    'export_state',
    'export_absence_verified',
    'sandbox_id',
    'sandbox_state',
    'sandbox_absence_verified',
    'last_error_code',
    'created_at',
    'updated_at',
    'revision',
    'record_hash',
  ], 'E2B cleanup journal record');
  if (value.schema !== JOURNAL_SCHEMA) {
    throw new TypeError('E2B cleanup journal record schema is invalid');
  }
  const normalized = {
    schema: JOURNAL_SCHEMA,
    record_id: requireOpaqueRef(value.record_id, 'cleanup journal record_id', { maxLength: 200 }),
    cleanup_ref: requireOpaqueRef(value.cleanup_ref, 'cleanup journal cleanup_ref', { maxLength: 200 }),
    provider_id: requireOpaqueRef(value.provider_id, 'cleanup journal provider_id', { maxLength: 200 }),
    template_id_hash: requireSha256Ref(value.template_id_hash, 'cleanup journal template_id_hash'),
    metadata_hash: requireSha256Ref(value.metadata_hash, 'cleanup journal metadata_hash'),
    export_id: requireOpaqueRef(value.export_id, 'cleanup journal export_id', { maxLength: 200 }),
    export_manifest_hash: requireNullableSha256(
      value.export_manifest_hash,
      'cleanup journal export_manifest_hash',
    ),
    export_workspace_digest: requireNullableSha256(
      value.export_workspace_digest,
      'cleanup journal export_workspace_digest',
    ),
    export_state: requireEnum(value.export_state, EXPORT_STATES, 'cleanup journal export_state'),
    export_absence_verified: value.export_absence_verified === true,
    sandbox_id: requireNullableString(value.sandbox_id, 'cleanup journal sandbox_id', {
      maxLength: 500,
    }),
    sandbox_state: requireEnum(value.sandbox_state, SANDBOX_STATES, 'cleanup journal sandbox_state'),
    sandbox_absence_verified: value.sandbox_absence_verified === true,
    last_error_code: requireNullableString(
      value.last_error_code,
      'cleanup journal last_error_code',
      { maxLength: 200 },
    ),
    created_at: requireIsoDate(value.created_at, 'cleanup journal created_at'),
    updated_at: requireIsoDate(value.updated_at, 'cleanup journal updated_at'),
    revision: value.revision,
    record_hash: requireSha256Ref(value.record_hash, 'cleanup journal record_hash'),
  };
  if (!Number.isSafeInteger(normalized.revision) || normalized.revision < 0) {
    throw new TypeError('cleanup journal revision must be a non-negative safe integer');
  }
  if (normalized.export_absence_verified !== (normalized.export_state === 'verified_absent')) {
    throw new Error('cleanup journal export absence claim is contradictory');
  }
  if (normalized.sandbox_absence_verified !== (normalized.sandbox_state === 'verified_absent')) {
    throw new Error('cleanup journal sandbox absence claim is contradictory');
  }
  if (normalized.sandbox_state === 'allocated' && normalized.sandbox_id === null) {
    throw new Error('cleanup journal allocated sandbox requires an id');
  }
  const expectedHash = sha256Ref({ ...normalized, record_hash: null });
  if (!safeEqual(expectedHash, normalized.record_hash)) {
    throw new Error('cleanup journal record hash mismatch');
  }
  return deepFreeze(normalized);
}

function withHash(value) {
  const normalized = cloneJson({ ...value, record_hash: null });
  normalized.record_hash = sha256Ref(normalized);
  return normalizeRecord(normalized);
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export class E2BCleanupJournal {
  constructor(options = {}) {
    this.directory = path.resolve(requireString(options.directory, 'cleanup journal directory'));
    this.clock = options.clock ?? (() => new Date());
    if (typeof this.clock !== 'function') throw new TypeError('cleanup journal clock must be a function');
    this.initialized = false;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    if (this.initialized) return this;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.initialized = true;
    return this;
  }

  #path(recordId) {
    const digest = sha256Ref(requireOpaqueRef(recordId, 'cleanup journal record id')).slice(7);
    return path.join(this.directory, `${digest}.json`);
  }

  async #read(recordId) {
    await this.initialize();
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.#path(recordId), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`Unknown E2B cleanup journal record: ${recordId}`);
      throw error;
    }
    const record = normalizeRecord(parsed);
    if (record.record_id !== recordId) throw new Error('cleanup journal record id/path mismatch');
    return record;
  }

  async #write(record, { create = false } = {}) {
    await this.initialize();
    const normalized = normalizeRecord(record);
    const target = this.#path(normalized.record_id);
    const temp = path.join(this.directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(normalized)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      if (create) {
        try {
          await readFile(target, 'utf8');
          throw new Error(`E2B cleanup journal record already exists: ${normalized.record_id}`);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      await rename(temp, target);
      await syncDirectory(this.directory);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temp).catch((unlinkError) => {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      });
      throw error;
    }
    return normalized;
  }

  async #serialized(action) {
    const pending = this.writeQueue.then(action, action);
    this.writeQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async createIntent(input = {}) {
    return this.#serialized(async () => {
      const now = requireIsoDate(this.clock(), 'cleanup journal clock');
      const record = withHash({
        schema: JOURNAL_SCHEMA,
        record_id: requireOpaqueRef(input.record_id, 'cleanup intent record_id', { maxLength: 200 }),
        cleanup_ref: requireOpaqueRef(input.cleanup_ref, 'cleanup intent cleanup_ref', { maxLength: 200 }),
        provider_id: requireOpaqueRef(input.provider_id, 'cleanup intent provider_id', { maxLength: 200 }),
        template_id_hash: requireSha256Ref(input.template_id_hash, 'cleanup intent template_id_hash'),
        metadata_hash: requireSha256Ref(input.metadata_hash, 'cleanup intent metadata_hash'),
        export_id: requireOpaqueRef(input.export_id, 'cleanup intent export_id', { maxLength: 200 }),
        export_manifest_hash: null,
        export_workspace_digest: null,
        export_state: 'creating',
        export_absence_verified: false,
        sandbox_id: null,
        sandbox_state: 'not_requested',
        sandbox_absence_verified: false,
        last_error_code: null,
        created_at: now,
        updated_at: now,
        revision: 0,
        record_hash: null,
      });
      return this.#write(record, { create: true });
    });
  }

  async #update(recordId, changes) {
    return this.#serialized(async () => {
      const current = await this.#read(recordId);
      const next = withHash({
        ...cloneJson(current),
        ...cloneJson(changes),
        updated_at: requireIsoDate(this.clock(), 'cleanup journal clock'),
        revision: current.revision + 1,
        record_hash: null,
      });
      return this.#write(next);
    });
  }

  async markExportActive(recordId, { manifest_hash, workspace_digest }) {
    return this.#update(recordId, {
      export_manifest_hash: requireSha256Ref(manifest_hash, 'export manifest_hash'),
      export_workspace_digest: requireSha256Ref(workspace_digest, 'export workspace_digest'),
      export_state: 'active',
      export_absence_verified: false,
      last_error_code: null,
    });
  }

  async markExportCleanupRequested(recordId) {
    return this.#update(recordId, {
      export_state: 'destroy_requested',
      export_absence_verified: false,
      last_error_code: null,
    });
  }

  async markExportVerifiedAbsent(recordId) {
    return this.#update(recordId, {
      export_state: 'verified_absent',
      export_absence_verified: true,
      last_error_code: null,
    });
  }

  async markExportUnknown(recordId, code) {
    return this.#update(recordId, {
      export_state: 'unknown',
      export_absence_verified: false,
      last_error_code: requireString(String(code), 'export cleanup error code', { maxLength: 200 }),
    });
  }

  async markAllocationRequested(recordId, metadataHash = undefined) {
    const changes = {
      sandbox_state: 'allocation_requested',
      sandbox_absence_verified: false,
      last_error_code: null,
    };
    if (metadataHash !== undefined) {
      changes.metadata_hash = requireSha256Ref(
        metadataHash,
        'allocation request metadata_hash',
      );
    }
    return this.#update(recordId, changes);
  }

  async markSandboxAllocated(recordId, sandboxId) {
    return this.#update(recordId, {
      sandbox_id: requireString(sandboxId, 'allocated sandbox id', { maxLength: 500 }),
      sandbox_state: 'allocated',
      sandbox_absence_verified: false,
      last_error_code: null,
    });
  }

  async markSandboxCleanupRequested(recordId, sandboxId = undefined) {
    const changes = {
      sandbox_state: 'destroy_requested',
      sandbox_absence_verified: false,
      last_error_code: null,
    };
    if (sandboxId !== undefined) {
      changes.sandbox_id = requireString(sandboxId, 'cleanup sandbox id', { maxLength: 500 });
    }
    return this.#update(recordId, changes);
  }

  async markSandboxVerifiedAbsent(recordId, sandboxId = undefined) {
    const changes = {
      sandbox_state: 'verified_absent',
      sandbox_absence_verified: true,
      last_error_code: null,
    };
    if (sandboxId !== undefined && sandboxId !== null) {
      changes.sandbox_id = requireString(sandboxId, 'absent sandbox id', { maxLength: 500 });
    }
    return this.#update(recordId, changes);
  }

  async markSandboxUnknown(recordId, code, sandboxId = undefined) {
    const changes = {
      sandbox_state: 'unknown',
      sandbox_absence_verified: false,
      last_error_code: requireString(String(code), 'sandbox cleanup error code', { maxLength: 200 }),
    };
    if (sandboxId !== undefined && sandboxId !== null) {
      changes.sandbox_id = requireString(sandboxId, 'unknown sandbox id', { maxLength: 500 });
    }
    return this.#update(recordId, changes);
  }

  async get(recordId) {
    return this.#read(recordId);
  }

  async listAll() {
    await this.initialize();
    const names = (await readdir(this.directory))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .sort();
    const records = [];
    for (const name of names) {
      const parsed = JSON.parse(await readFile(path.join(this.directory, name), 'utf8'));
      const record = normalizeRecord(parsed);
      if (path.basename(this.#path(record.record_id)) !== name) {
        throw new Error('cleanup journal filename does not match record identity');
      }
      records.push(record);
    }
    return deepFreeze(records);
  }

  async listPending() {
    const all = await this.listAll();
    return deepFreeze(all.filter((record) => (
      !record.export_absence_verified || !record.sandbox_absence_verified
    )));
  }
}

export const E2B_CLEANUP_JOURNAL_SCHEMA = JOURNAL_SCHEMA;
