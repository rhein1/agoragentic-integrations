import { canonicalize, sha256Ref } from '../../src/index.mjs';
import {
  E2B_BOOT_EVIDENCE_PATH,
  createBootEvidenceEnvelope,
  createE2BBirthAttestation,
  e2bBirthRequestPaths,
} from '../../e2b-template/lib/runtime-contract.mjs';
import { E2B_RISK_FORK_PATHS } from '../../src/adapters/e2b.mjs';
import {
  MALICIOUS_MCP_ATTACK_IDS,
  MALICIOUS_MCP_CALL_ARGUMENTS,
  MALICIOUS_MCP_PARENT_CREDENTIAL_REF,
  MALICIOUS_MCP_PARENT_ENV_CANARY_KEY,
  MALICIOUS_MCP_PARENT_ENV_FIXTURE,
  MALICIOUS_MCP_PARENT_WORKSPACE_REF,
  MALICIOUS_MCP_SERVER_REF,
  MALICIOUS_MCP_TOOL_NAME,
  runMaliciousMcpFixtureOverStdio,
} from '../fixtures/malicious-stdio-mcp.mjs';

export const FAKE_E2B_SDK_CONTRACT_VERSION = '2.39.0';
export const FAKE_E2B_TEMPLATE_ID = 'template-risk-fork-hackathon-clean-v1';
export const FAKE_E2B_TEMPLATE_HASH = sha256Ref('risk-fork-hackathon-clean-template-v1');
export const FAKE_E2B_TEMPLATE_PROVENANCE_HASH = sha256Ref(
  'risk-fork-hackathon-clean-template-provenance-v1',
);
export const FAKE_E2B_BOOTSTRAP_HASH = sha256Ref('risk-fork-hackathon-bootstrap-v1');
export const FAKE_E2B_RUNNER_HASH = sha256Ref('risk-fork-hackathon-runner-v1');
export const FAKE_E2B_BOOTSTRAP_COMMAND = 'risk-fork-fake-e2b-bootstrap';
export const FAKE_E2B_RUNNER_COMMAND = 'risk-fork-fake-e2b-runner';
export const FAKE_E2B_MAX_TIMEOUT_MS = 180_000;

export const FAKE_E2B_ATTACK_ATTEMPTS = MALICIOUS_MCP_ATTACK_IDS;

const FAULTS = Object.freeze([
  'none',
  'create_failure',
  'ambiguous_allocation',
  'command_timeout',
  'stale_result',
  'wrong_job',
  'wrong_capsule',
  'wrong_parent',
  'wrong_provider',
  'wrong_schema',
  'cleanup_failure',
  'absence_query_failure',
]);

function frozen(value) {
  return Object.freeze(structuredClone(value));
}

function parseFlag(command, flag) {
  const match = new RegExp(`${flag}\\s+(\\S+)`).exec(command);
  return match?.[1] ?? null;
}

function notFound() {
  const error = new Error('Synthetic sandbox is absent');
  error.status = 404;
  error.code = 'NOT_FOUND';
  return error;
}

function exactEmptyObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 0;
}

function evaluateSyntheticAttackRequests({ fixture, record, job }) {
  const expectedFixtureBinding = {
    mcp_phase: 'tools/call',
    mcp_server_ref: MALICIOUS_MCP_SERVER_REF,
    tool_name: MALICIOUS_MCP_TOOL_NAME,
    effective_arguments_hash: sha256Ref(MALICIOUS_MCP_CALL_ARGUMENTS),
  };
  if (canonicalize(fixture.call_binding) !== canonicalize(expectedFixtureBinding)
    || canonicalize(expectedFixtureBinding) !== canonicalize({
    mcp_phase: job.mcp_phase,
    mcp_server_ref: job.mcp_server_ref,
    tool_name: job.tool_name,
    effective_arguments_hash: job.effective_arguments_hash,
    })) {
    throw new Error('Synthetic malicious MCP call did not match the exact job binding');
  }
  const requestIds = fixture.attack_requests.map((request) => request.attack);
  if (canonicalize(requestIds) !== canonicalize(MALICIOUS_MCP_ATTACK_IDS)) {
    throw new Error('Synthetic malicious MCP attack request set was invalid');
  }
  const byId = new Map(fixture.attack_requests.map((request) => [request.attack, request]));
  if (byId.size !== MALICIOUS_MCP_ATTACK_IDS.length
    || byId.get('read_parent_environment')?.canary_key_ref
      !== MALICIOUS_MCP_PARENT_ENV_CANARY_KEY
    || byId.get('read_parent_only_credential_path')?.target_ref
      !== MALICIOUS_MCP_PARENT_CREDENTIAL_REF
    || byId.get('mutate_parent_workspace')?.target_ref
      !== MALICIOUS_MCP_PARENT_WORKSPACE_REF) {
    throw new Error('Synthetic malicious MCP attack request bindings were invalid');
  }
  if (fixture.parent_environment_observation.canary_declared !== true
    || fixture.parent_environment_observation.key_count !== 1
    || fixture.parent_environment_observation.value_serialized !== false
    || fixture.child_environment_observation.parent_canary_present !== false
    || fixture.child_environment_observation.provider_key_present !== false) {
    throw new Error('Synthetic child received a prohibited parent or provider environment key');
  }
  const parentCredentialPresent = [...record.files.keys()].some((entry) => {
    const normalized = entry.replaceAll('\\', '/');
    return normalized === MALICIOUS_MCP_PARENT_CREDENTIAL_REF
      || normalized.endsWith(`/${MALICIOUS_MCP_PARENT_CREDENTIAL_REF}`);
  });
  if (parentCredentialPresent) {
    throw new Error('Synthetic parent-only credential was present in the child export');
  }
  if (canonicalize(record.create_options.network) !== canonicalize({
    allowOut: [],
    denyOut: ['0.0.0.0/0'],
    allowPublicTraffic: false,
  })) {
    throw new Error('Synthetic attack evaluation did not retain the deny-all network request');
  }
  if (canonicalize(fixture.typed_result) !== canonicalize({
    summary: 'One bounded synthetic result passed exact validation.',
    fixture_id: 'e2b-malicious-mcp-containment',
  })) {
    throw new Error('Synthetic malicious MCP returned an unexpected typed result');
  }
  return Object.freeze([
    { attack: 'prompt_injection_during_tools_list', outcome: 'quarantined_hash_only' },
    { attack: 'ignore_parent_policy', outcome: 'rejected_by_clean_controller' },
    { attack: 'read_parent_environment', outcome: 'parent_canary_absent' },
    { attack: 'read_parent_only_credential_path', outcome: 'absent_from_child_export' },
    { attack: 'mutate_parent_workspace', outcome: 'rejected_before_parent_effect' },
    {
      attack: 'unauthorized_external_network',
      outcome: 'denied_by_fake_creation_profile_not_live_verified',
    },
    { attack: 'insert_raw_narrative_into_parent_memory', outcome: 'quarantined_hash_only' },
    { attack: 'smuggle_authority_shaped_fields', outcome: 'rejected_by_closed_schema' },
  ].map((item) => Object.freeze(item)));
}

function validateCreateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Fake E2B create options must be an object');
  }
  if (!Number.isSafeInteger(options.timeoutMs)
    || options.timeoutMs < 1_000
    || options.timeoutMs > FAKE_E2B_MAX_TIMEOUT_MS) {
    throw new Error('Fake E2B timeout must be between 1000 and 180000 milliseconds');
  }
  if (options.secure !== true || options.allowInternetAccess !== false) {
    throw new Error('Fake E2B requires secure mode and denied internet access');
  }
  if (JSON.stringify(options.network) !== JSON.stringify({
    allowOut: [],
    denyOut: ['0.0.0.0/0'],
    allowPublicTraffic: false,
  })) {
    throw new Error('Fake E2B requires the exact deny-all network request');
  }
  if (JSON.stringify(options.lifecycle) !== JSON.stringify({
    onTimeout: 'kill',
    autoResume: false,
  })) {
    throw new Error('Fake E2B requires kill-on-timeout and no auto-resume');
  }
  if (!exactEmptyObject(options.envs)
    || !exactEmptyObject(options.iam?.tokens)
    || !exactEmptyObject(options.volumeMounts)) {
    throw new Error('Fake E2B forbids inherited env, IAM tokens, and persistent mounts');
  }
  return options;
}

function createBootEvidence({ now, request }) {
  return createBootEvidenceEnvelope({
    observed_at: now,
    expires_at: new Date(Date.parse(now) + 5 * 60_000).toISOString(),
    boot_nonce: request.birth_nonce,
    boot_id_hash: sha256Ref('fake-e2b-boot-id'),
    entropy_hash: sha256Ref('fake-e2b-fresh-entropy'),
    bootstrap_artifact_hash: FAKE_E2B_BOOTSTRAP_HASH,
    runner_artifact_hash: FAKE_E2B_RUNNER_HASH,
    measurements: {
      environment_key_count: 0,
      process_count: 2,
      socket_count: 0,
      mount_count: 0,
      credential_path_count: 0,
    },
    observation_hashes: {
      environment_keys_hash: sha256Ref([]),
      processes_hash: sha256Ref(['fake-init', 'fake-risk-fork-runner']),
      sockets_hash: sha256Ref([]),
      mounts_hash: sha256Ref([]),
      credential_paths_hash: sha256Ref([]),
      ipv4_probe_hash: sha256Ref('fake-observation-ipv4-denied-unqualified'),
      ipv6_probe_hash: sha256Ref('fake-observation-ipv6-denied-unqualified'),
    },
    claims: {
      inherited_parent_processes_absent: true,
      unauthorized_environment_absent: true,
      credential_files_absent: true,
      wallet_signing_material_absent: true,
      inherited_authority_records_absent: true,
      persistent_mounts_absent: true,
      unauthorized_sockets_absent: true,
      first_instruction_ipv4_egress_denied: true,
      first_instruction_ipv6_egress_denied: true,
      fresh_entropy_verified: true,
      trusted_runtime_artifacts_verified: true,
    },
  });
}

export function createFakeE2BSdk({
  fault = 'none',
  now = '2030-01-01T00:10:00.000Z',
  parentEnvironmentFixture = MALICIOUS_MCP_PARENT_ENV_FIXTURE,
} = {}) {
  if (!FAULTS.includes(fault)) throw new TypeError(`Unsupported fake E2B fault: ${fault}`);
  if (!Number.isFinite(Date.parse(now))) throw new TypeError('Fake E2B now must be ISO time');

  const state = {
    allocation_count: 0,
    create_attempt_count: 0,
    retry_count: 0,
    rejected_repeat_attempt_count: 0,
    events: [],
    sandboxes: new Map(),
    last_sandbox_id: null,
  };

  function event(type, fields = {}) {
    state.events.push(frozen({ type, ...fields }));
  }

  function sandboxInfo(record) {
    return {
      sandboxId: record.sandbox_id,
      templateId: FAKE_E2B_TEMPLATE_ID,
      state: record.running ? 'running' : 'killed',
      allowInternetAccess: false,
      network: {
        allowOut: [],
        denyOut: ['0.0.0.0/0'],
        allowPublicTraffic: false,
      },
      lifecycle: { onTimeout: 'kill', autoResume: false },
      volumeMounts: [],
      metadata: structuredClone(record.create_options.metadata),
      endAt: new Date(Date.parse(now) + record.timeout_ms),
    };
  }

  function attestBirth(record, request) {
    const bootEvidence = createBootEvidence({ now, request });
    const attestation = createE2BBirthAttestation({
      request,
      bootEvidence,
      observed_at: now,
    });
    const paths = e2bBirthRequestPaths(request.request_hash);
    record.files.set(E2B_BOOT_EVIDENCE_PATH, Buffer.from(`${canonicalize(bootEvidence)}\n`));
    record.files.set(paths.attestation, Buffer.from(`${canonicalize(attestation)}\n`));
    record.files.set(paths.consumed, record.files.get(paths.request));
    record.files.set(paths.consumed_trigger, record.files.get(paths.trigger));
    record.files.delete(paths.request);
    record.files.delete(paths.trigger);
    record.boot_evidence = bootEvidence;
    event('birth_attestation_observed', {
      sandbox_id: record.sandbox_id,
      request_hash: request.request_hash,
      evidence_hash: bootEvidence.evidence_hash,
    });
  }

  function createChild(record) {
    const child = {
      sandboxId: record.sandbox_id,
      files: {
        async write(target, data) {
          const entries = Array.isArray(target) ? target : [{ path: target, data }];
          for (const entry of entries) {
            const bytes = Buffer.isBuffer(entry.data)
              ? Buffer.from(entry.data)
              : Buffer.from(String(entry.data));
            record.files.set(entry.path, bytes);
            if (entry.path.endsWith('.ready') && entry.path.includes('/birth-request.')) {
              const requestHash = bytes.toString('utf8').trim();
              const requestPaths = e2bBirthRequestPaths(requestHash);
              const request = JSON.parse(record.files.get(requestPaths.request).toString('utf8'));
              attestBirth(record, request);
            }
          }
        },
        async read(target, options = {}) {
          if (!record.files.has(target)) throw notFound();
          const bytes = Buffer.from(record.files.get(target));
          if (options.format === 'stream') {
            return new ReadableStream({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            });
          }
          return bytes;
        },
        async remove(target) {
          record.files.delete(target);
        },
      },
      commands: {
        async run(command, commandOptions = {}) {
          if (command === FAKE_E2B_BOOTSTRAP_COMMAND) {
            const request = JSON.parse(
              record.files.get(E2B_RISK_FORK_PATHS.identity).toString('utf8'),
            );
            record.identity_hash = request.fork_identity.identity_hash;
            const claims = {
              inherited_parent_processes_absent: true,
              unauthorized_environment_absent: true,
              credential_files_absent: true,
              wallet_signing_material_absent: true,
              inherited_authority_records_absent: true,
              persistent_mounts_absent: true,
              unauthorized_sockets_absent: true,
              network_policy_enforced: true,
              fresh_fork_identity_verified: true,
              fresh_session_nonce_verified: true,
              fresh_entropy_verified: true,
              workspace_manifest_verified: true,
              trusted_runtime_artifacts_verified: true,
            };
            const attestation = {
              schema: 'agoragentic.risk-fork.child-bootstrap-attestation.v1',
              phase: request.phase,
              status: 'verified',
              bootstrap_request_hash: request.request_hash,
              child_sandbox_id_hash: sha256Ref(record.sandbox_id),
              template_id_hash: sha256Ref(FAKE_E2B_TEMPLATE_ID),
              template_evidence_hash: FAKE_E2B_TEMPLATE_HASH,
              capsule_hash: request.capsule_hash,
              identity_hash: request.fork_identity.identity_hash,
              network_policy_hash: request.network_policy_hash,
              metadata_hash: sha256Ref(record.create_options.metadata),
              workspace_digest: request.expected_workspace_digest,
              trusted_bootstrap_artifact_hash: FAKE_E2B_BOOTSTRAP_HASH,
              trusted_runner_artifact_hash: FAKE_E2B_RUNNER_HASH,
              boot_evidence_hash: record.boot_evidence.evidence_hash,
              attested_at: now,
              expires_at: new Date(Date.parse(now) + 60_000).toISOString(),
              claims,
            };
            event('trusted_bootstrap_executed', {
              sandbox_id: record.sandbox_id,
              phase: request.phase,
              request_hash: request.request_hash,
            });
            return { exitCode: 0, stdout: JSON.stringify(attestation), stderr: '' };
          }

          if (!command.startsWith(`${FAKE_E2B_RUNNER_COMMAND} --job `)) {
            throw new Error('Fake E2B rejected an untrusted command');
          }
          if (fault === 'command_timeout') return new Promise(() => {});
          const jobPath = parseFlag(command, '--job');
          const resultPath = parseFlag(command, '--result');
          const job = JSON.parse(record.files.get(jobPath).toString('utf8'));
          const fixture = await runMaliciousMcpFixtureOverStdio({
            parentEnvironment: parentEnvironmentFixture,
          });
          if (canonicalize(fixture.typed_result)
            !== canonicalize(job.operation.commit_candidate?.payload)) {
            throw new Error('Synthetic malicious MCP typed result did not match the closed job');
          }
          const attackOutcomes = evaluateSyntheticAttackRequests({ fixture, record, job });
          record.parent_environment_observation = fixture.parent_environment_observation;
          event('malicious_stdio_session_completed', {
            sandbox_id: record.sandbox_id,
            transport: fixture.transport,
            tools_list_hash: fixture.tools_list_hash,
          });
          for (const attempted of attackOutcomes) {
            event('synthetic_attack_boundary_evaluated', {
              sandbox_id: record.sandbox_id,
              attack: attempted.attack,
              outcome: attempted.outcome,
            });
          }
          const commitCandidate = {
            ...structuredClone(job.operation.commit_candidate),
            payload: structuredClone(fixture.typed_result),
          };
          const result = {
            schema: 'agoragentic.risk-fork.runner-result.v1',
            status: 'completed',
            job_id: fault === 'wrong_job' ? `rfj_${'0'.repeat(32)}` : job.job_id,
            job_hash: fault === 'stale_result' ? sha256Ref('stale-job') : job.job_hash,
            parent_state_hash: fault === 'wrong_parent'
              ? sha256Ref('wrong-parent')
              : job.parent_state_hash,
            capsule_hash: fault === 'wrong_capsule' ? sha256Ref('wrong-capsule') : job.capsule_hash,
            identity_hash: job.identity_hash,
            provider_ref: fault === 'wrong_provider'
              ? 'provider:wrong-synthetic'
              : job.provider_ref,
            template_id_hash: job.template_id_hash,
            mcp_phase: job.mcp_phase,
            mcp_server_ref: job.mcp_server_ref,
            tool_name: job.tool_name,
            effective_arguments_hash: job.effective_arguments_hash,
            network_policy_hash: job.network_policy_hash,
            operation_hash: job.operation_hash,
            execution_mode: job.execution_mode,
            trusted_runner_artifact_hash: FAKE_E2B_RUNNER_HASH,
            expected_result_schema_hash: fault === 'wrong_schema'
              ? sha256Ref('wrong-result-schema')
              : job.expected_result_schema_hash,
            commit_candidate: commitCandidate,
            commit_candidate_hash: sha256Ref(commitCandidate),
          };
          record.files.set(resultPath, Buffer.from(JSON.stringify(result)));
          record.tainted_narrative_hash = sha256Ref(fixture.raw_child_output);
          record.child_environment_observation = structuredClone(
            fixture.child_environment_observation,
          );
          event('typed_result_emitted', {
            sandbox_id: record.sandbox_id,
            job_id: job.job_id,
            job_hash: job.job_hash,
            tainted_narrative_hash: record.tainted_narrative_hash,
            raw_narrative_included: false,
          });
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
      async setTimeout(timeoutMs) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs > FAKE_E2B_MAX_TIMEOUT_MS) {
          throw new Error('Fake E2B timeout update exceeds the profile');
        }
        record.timeout_ms = timeoutMs;
        event('timeout_updated', { sandbox_id: record.sandbox_id, timeout_ms: timeoutMs });
        return true;
      },
      async kill() {
        event('kill_requested', { sandbox_id: record.sandbox_id });
        if (fault === 'cleanup_failure') {
          event('kill_outcome_unknown', { sandbox_id: record.sandbox_id });
          throw new Error('Synthetic kill acknowledgement unavailable');
        }
        record.running = false;
        event('kill_acknowledged', { sandbox_id: record.sandbox_id });
        return true;
      },
    };
    return child;
  }

  class Sandbox {
    static async create(templateId, createOptions) {
      state.create_attempt_count += 1;
      if (state.create_attempt_count > 1) state.rejected_repeat_attempt_count += 1;
      event('allocation_requested', {
        attempt: state.create_attempt_count,
        template_id: templateId,
        timeout_ms: createOptions?.timeoutMs ?? null,
      });
      if (state.create_attempt_count > 1) {
        throw new Error('Fake E2B profile permits exactly one allocation attempt');
      }
      if (templateId !== FAKE_E2B_TEMPLATE_ID) throw new Error('Fake E2B template mismatch');
      validateCreateOptions(createOptions);
      if (fault === 'create_failure') throw new Error('Synthetic provider create failure');
      state.allocation_count += 1;
      const sandboxId = `sandbox-fake-e2b-${String(state.allocation_count).padStart(4, '0')}`;
      const record = {
        sandbox_id: sandboxId,
        create_options: structuredClone(createOptions),
        timeout_ms: createOptions.timeoutMs,
        files: new Map(),
        running: true,
        boot_evidence: null,
        identity_hash: null,
        tainted_narrative_hash: null,
        parent_environment_observation: null,
        child_environment_observation: null,
      };
      record.child = createChild(record);
      state.sandboxes.set(sandboxId, record);
      state.last_sandbox_id = sandboxId;
      event('sandbox_id_observed', { sandbox_id: sandboxId });
      if (fault === 'ambiguous_allocation') {
        event('allocation_outcome_unknown', { sandbox_id_hash: sha256Ref(sandboxId) });
        throw new Error('Synthetic ambiguous allocation after sandbox creation');
      }
      return record.child;
    }

    static async getInfo(sandboxId) {
      event('running_state_query', { sandbox_id: sandboxId });
      if (fault === 'absence_query_failure') {
        event('running_state_query_unknown', { sandbox_id: sandboxId });
        throw new Error('Synthetic getInfo uncertainty');
      }
      const record = state.sandboxes.get(sandboxId);
      if (!record || !record.running) {
        event('provider_absence_observed', {
          sandbox_id: sandboxId,
          method: 'getInfo',
        });
        throw notFound();
      }
      event('running_state_observed', { sandbox_id: sandboxId, state: 'running' });
      return sandboxInfo(record);
    }

    static list(listOptions = {}) {
      event('metadata_list_query', { query_hash: sha256Ref(listOptions) });
      let delivered = false;
      return {
        get hasNext() { return delivered === false; },
        async nextItems() {
          delivered = true;
          const queryMetadata = listOptions?.query?.metadata ?? {};
          const matches = [...state.sandboxes.values()]
            .filter((record) => record.running)
            .filter((record) => Object.entries(queryMetadata).every(
              ([key, value]) => record.create_options.metadata?.[key] === value,
            ))
            .map((record) => sandboxInfo(record));
          event('metadata_list_observed', {
            query_hash: sha256Ref(listOptions),
            matching_count: matches.length,
          });
          return matches;
        },
      };
    }

    static async kill(sandboxId) {
      const record = state.sandboxes.get(sandboxId);
      if (!record) throw notFound();
      return record.child.kill();
    }

    static async createSnapshot() { throw new Error('Live or memory snapshots are prohibited'); }
    static async fork() { throw new Error('Direct live sandbox forks are prohibited'); }
    static async connect() { throw new Error('Reconnect is prohibited'); }
    static async pause() { throw new Error('Persistent suspension is prohibited'); }
  }

  function evidence() {
    const last = state.last_sandbox_id ? state.sandboxes.get(state.last_sandbox_id) : null;
    const count = (type) => state.events.filter((item) => item.type === type).length;
    const sandboxRunning = last?.running ?? false;
    const cleanupUnknown = (
      count('kill_outcome_unknown') > 0 || count('running_state_query_unknown') > 0
    );
    const orphanReconciliationRequired = cleanupUnknown || (
      sandboxRunning && count('allocation_outcome_unknown') > 0
    );
    const parentCredentialInChild = last ? [...last.files.keys()].some((entry) => {
      const normalized = entry.replaceAll('\\', '/');
      return normalized === MALICIOUS_MCP_PARENT_CREDENTIAL_REF
        || normalized.endsWith(`/${MALICIOUS_MCP_PARENT_CREDENTIAL_REF}`);
    }) : false;
    return frozen({
      schema: 'agoragentic.risk-fork.fake-e2b-sdk-evidence.v1',
      sdk_contract_version: FAKE_E2B_SDK_CONTRACT_VERSION,
      mode: 'fake_e2b_local_contract_simulation',
      provider_calls: 0,
      provider_qualified: false,
      containment_verified: false,
      allocation_attempt_count: state.create_attempt_count,
      allocation_count: state.allocation_count,
      retry_count: state.retry_count,
      rejected_repeat_attempt_count: state.rejected_repeat_attempt_count,
      fallback_provider: null,
      sandbox_id: state.last_sandbox_id,
      sandbox_running: sandboxRunning,
      timeout_ms: last?.timeout_ms ?? null,
      ttl_countdown: last ? {
        start_seconds: Math.floor(last.timeout_ms / 1_000),
        remaining_seconds: sandboxRunning ? Math.floor(last.timeout_ms / 1_000) : 0,
        terminal_reason: cleanupUnknown
          ? 'cleanup_unknown'
          : sandboxRunning
            ? 'still_running_or_unknown'
            : 'destroyed',
      } : null,
      network_request: last ? structuredClone(last.create_options.network) : null,
      ipv4_containment: 'fake_observation_only_not_live_qualified',
      ipv6_containment: 'fake_observation_only_not_live_qualified',
      parent_environment_canary_declared:
        last?.parent_environment_observation?.canary_declared ?? false,
      parent_environment_fixture_key_count:
        last?.parent_environment_observation?.key_count ?? null,
      parent_environment_fixture_value_serialized:
        last?.parent_environment_observation?.value_serialized ?? null,
      inherited_parent_environment_canary_count: last?.child_environment_observation
        ? (last.child_environment_observation.parent_canary_present === true ? 1 : 0)
        : null,
      child_environment_key_count: last?.child_environment_observation?.key_count ?? null,
      child_environment_key_names_hash:
        last?.child_environment_observation?.key_names_hash ?? null,
      child_provider_key_present:
        last?.child_environment_observation?.provider_key_present ?? false,
      parent_only_credential_in_child: parentCredentialInChild,
      persistent_mount_count: 0,
      public_ingress_enabled: false,
      stdio_mcp_transport: count('malicious_stdio_session_completed') > 0
        ? 'local_stdio_subprocess'
        : 'not_run',
      cleanup_tracking: {
        allocation_requested: count('allocation_requested') === 1,
        sandbox_id_observed: count('sandbox_id_observed') === 1,
        kill_requested: count('kill_requested') > 0,
        kill_acknowledged: count('kill_acknowledged') > 0,
        running_state_query_count: count('running_state_query'),
        exact_metadata_list_query_count: count('metadata_list_query'),
        exact_metadata_list_observation_count: count('metadata_list_observed'),
        absence_observation_count: count('provider_absence_observed'),
        cleanup_unknown: cleanupUnknown,
        orphan_reconciliation_required: orphanReconciliationRequired,
      },
      tainted_narrative_hash: last?.tainted_narrative_hash ?? null,
      raw_narrative_included: false,
      attack_attempts: FAKE_E2B_ATTACK_ATTEMPTS.map((attack) => {
        const observed = state.events.find((item) => (
          item.type === 'synthetic_attack_boundary_evaluated' && item.attack === attack
        ));
        return { attack, status: observed?.outcome ?? 'not_attempted' };
      }),
      events: state.events.map((item) => structuredClone(item)),
    });
  }

  return Object.freeze({ Sandbox, evidence });
}
