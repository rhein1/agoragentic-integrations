import { hashValue } from './index.mjs';

export const PRIME_AGENT_EXTENSION_VERSION = '0.2.0-alpha.0';
export const PRIME_AGENT_RUNTIME_REQUEST_SCHEMA = 'agoragentic.agent-os.prime-agent-runtime-request.v1';
export const PRIME_AGENT_RUNTIME_PLAN_SCHEMA = 'agoragentic.agent-os.prime-agent-runtime-plan.v1';
export const PRIME_AGENT_RUNTIME_ADAPTER_ID = 'prime-agent-rpc-contract';
export const PRIME_AGENT_RUNTIME_ADAPTER_VERSION = '0.3.0-alpha.0';

export const PRIME_AGENT_EVIDENCE_REFS = Object.freeze({
  qualification_evidence: 'prime-agent-governance/evidence/prime-agent-v0.7.2-qualification.v1.json',
  compatibility_receipt: 'prime-agent-governance/evidence/prime-agent-v0.7.2-released-compatibility.v1.json',
  integrity_profile: 'prime-agent-governance/evidence/prime-agent-v0.7.2-integrity-profile.v1.json',
  dependency_audit: 'prime-agent-governance/evidence/prime-agent-v0.7.2-dependency-audit.v1.json',
  marketplace_record: 'prime-agent-governance/evidence/prime-agent-v0.7.2-agent-os-qualification.v1.json',
});

export const PRIME_AGENT_KNOWN_LIMITATIONS = Object.freeze([
  'Policy behavior is covered by deterministic source and adversarial tests, but policy_enforcement_passed remains false because the provider-free released-host run did not exercise real tool-call interception.',
  'The raw release tarball is not standalone and requires its declared dependency graph to be materialized before the CLI can load.',
  'The provider-free Windows x64 run is bound to a committed dependency lock and the observed first-party, installed dependency, and source-extension tree digests; the integrity profile separately pins the independently reproduced Linux x64 dependency tuple. This is compatibility evidence, not an owner-approved public compatibility claim.',
  'Promotion is blocked because the exact production dependency closure includes direct extract-zip 2.0.1, affected by high-severity GHSA-jmr9-qjv8-65gv with no patched version reported at the captured audit time.',
  'Prime Agent v0.7.2 publishes a ./hooks export whose declared dist/core/hooks/index.js target is absent from the release artifact.',
  'No restricted Linux canary, active cancellation, stale-worker recovery, hosted endpoint, or production activation was observed.',
  'The source-only extension package is unpublished; extension_package_digest binds the reviewed source manifest, not an npm registry artifact.',
  'Prime Agent v0.8.1 was observed as newer; this record keeps the historical v0.7.2 pin and does not auto-update or auto-promote.',
]);

const HOST_IDENTITY_BODY = Object.freeze({
  repository: 'PrimeIntellect-ai/prime-agent',
  tag: 'v0.7.2',
  version: '0.7.2',
  commit: '83a0f9f9566219551fcb6ffaf7f519a815749a58',
  release_asset: 'prime-agent-0.7.2.tgz',
  release_asset_sha256: 'sha256:bc5471f2a626d727b88a45eb745fff93b10c554a3c4fc5912f25d8c64b987f5e',
});

export const PRIME_AGENT_HOST_IDENTITY = Object.freeze({
  ...HOST_IDENTITY_BODY,
  identity_hash: hashValue(HOST_IDENTITY_BODY),
});

export const PRIME_AGENT_SAFE_LAUNCH_REQUIREMENTS = Object.freeze({
  environment_inheritance: 'allowlist_only',
  inherited_host_environment_keys: Object.freeze([
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'LANG',
    'LC_ALL',
  ]),
  required_environment: Object.freeze({
    HOME: '<ISOLATED_TEST_HOME>',
    USERPROFILE: '<ISOLATED_TEST_HOME>',
    APPDATA: '<ISOLATED_TEST_HOME_APPDATA_ROAMING>',
    LOCALAPPDATA: '<ISOLATED_TEST_HOME_APPDATA_LOCAL>',
    XDG_CONFIG_HOME: '<ISOLATED_TEST_XDG_CONFIG_HOME>',
    XDG_DATA_HOME: '<ISOLATED_TEST_XDG_DATA_HOME>',
    XDG_CACHE_HOME: '<ISOLATED_TEST_XDG_CACHE_HOME>',
    XDG_STATE_HOME: '<ISOLATED_TEST_XDG_STATE_HOME>',
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PRIME_AGENT_TELEMETRY: '0',
    PRIME_AGENT_CODING_AGENT_DIR: '<ISOLATED_TEST_CODING_AGENT_DIR>',
    PRIME_AGENT_SESSION_DIR: '<ISOLATED_TEST_SESSION_DIR>',
    TMP: '<ISOLATED_TEST_TEMP_DIR>',
    TEMP: '<ISOLATED_TEST_TEMP_DIR>',
    AGORAGENTIC_NO_SPEND: '1',
    AGORAGENTIC_ALLOW_REAL_SPEND: '0',
    AGORAGENTIC_ALLOW_NETWORK_CANARIES: '0',
  }),
  isolated_working_directory: '<ISOLATED_TEST_ROOT>',
  ambient_home_or_profile_lookup: false,
  daemon_socket: '<ISOLATED_TEST_SOCKET>',
  daemon_socket_unique_per_run: true,
  global_daemon_reuse: false,
  bounded_shutdown_wait_required: true,
  shutdown_wait_condition: 'daemon_endpoint_disappeared',
});

const HOST_CONTRACT_BODY = Object.freeze({
  ...PRIME_AGENT_HOST_IDENTITY,
  release_asset_url: 'https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.7.2/prime-agent-0.7.2.tgz',
  release_asset_size_bytes: 9387295,
  release_first_party_file_count: 1381,
  release_first_party_tree_digest: 'sha256:355a235390ce870a1abbce9e27ad0efceb1d9c5da97bd9106f66b7c18d1831ee',
  dependency_lock_sha256: 'sha256:924b09f57185f045d5ec941d45460181f4ddd1d1876dace7ed50bd63cf0147e8',
  source_adapter_sha256: 'sha256:7128b6025bffd5ea765567cbd124c286e44b0bb629914e9fa7ba7f0ae5f1eac8',
  source_adapter_test_sha256: 'sha256:555dff5d47e18abf50746fcdc1d30f06eaaee9383fb1ce15ab94c4b7b7d08c55',
  node_engine: '>=22.8.0',
  runtime_mode: 'rpc',
  rpc_framing: 'jsonl_lf',
  extension_loading: 'cli_extension_flag',
  extension_manifest_key: 'pi.extensions',
  extension_discovery_keyword: 'pi-package',
  safe_launch_requirements: PRIME_AGENT_SAFE_LAUNCH_REQUIREMENTS,
});

export const PRIME_AGENT_HOST_CONTRACT = Object.freeze({
  ...HOST_CONTRACT_BODY,
  contract_hash: hashValue(HOST_CONTRACT_BODY),
});

export const PRIME_AGENT_COMMAND_PREVIEW = Object.freeze([
  'node',
  '<PINNED_PRIME_AGENT_PACKAGE>/dist/bundle/cli.js',
  '--offline',
  '--mode',
  'rpc',
  '--daemon-socket',
  '<ISOLATED_TEST_SOCKET>',
  '--no-session',
  '--no-builtin-tools',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
  '-e',
  '<AGORAGENTIC_EXTENSION_PACKAGE>',
]);

export const PRIME_AGENT_REQUIRED_RPC_COMMANDS = Object.freeze([
  'get_state',
  'get_commands',
  'prompt_extension_command',
  'abort_idle',
  'observe_missing',
  'unobserve_missing',
  'malformed_frame',
  'unknown_command',
  'eof_shutdown',
]);

export const PRIME_AGENT_HARD_ENFORCEMENT = Object.freeze([
  'sandbox_process_boundary',
  'filesystem_policy',
  'network_egress_policy',
  'credential_broker',
  'payment_adapter',
  'owner_stop_and_revoke',
  'crash_recovery',
  'uncertain_side_effect_reconciliation',
  'transaction_assurance',
]);
