import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sha256Ref } from '../src/canonical.mjs';
import {
  containsObviousCapabilityLikeText,
  isForbiddenAuthorityShapeKey,
} from '../src/authority-shape.mjs';
import { validateChildOperation } from '../src/child-operation.mjs';
import {
  RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES,
  RISK_FORK_FRAMEWORK_SCHEMAS,
  createRiskForkFrameworkToolPlan,
} from '../src/framework-tool-adapter.mjs';
import {
  RISK_FORK_HOST_DIAGNOSTIC_CODES,
  createRiskForkImportEnvelope,
} from '../src/host-boundary.mjs';
import {
  RISK_FORK_MCP_PHASE_PLAN_REQUEST_SCHEMA,
  createRiskForkMcpChildOperation,
} from '../src/mcp-host-adapter.mjs';
import { scanTaintedValue, validateCommitCandidate } from '../src/taint-gate.mjs';
import {
  scanE2BStagedBytesAuthorityFree,
} from '../src/adapters/e2b-source-verifier.mjs';
import {
  createImmutableWorkspaceExport,
} from '../src/adapters/e2b-workspace-export.mjs';
import { validateDemoOperation } from '../hackathon/src/security.mjs';
import {
  containsSecretShapedText,
  containsSerializedCredentialMaterial,
  foldSecurityConfusables,
  securityKeyFingerprint,
  SECURITY_UNICODE_17_PROFILE,
} from '../src/util.mjs';

const SYNTHETIC_SECRET = 'synthetic-value-123456';

test('scan-only confusable fold preserves ASCII and canonical payload text', () => {
  const ascii = 'm10 authorization api_key ignore previous instructions';
  assert.equal(foldSecurityConfusables(ascii), ascii);

  const original = `api_k\u0435y=${SYNTHETIC_SECRET}`;
  const folded = foldSecurityConfusables(original);
  assert.equal(original, `api_k\u0435y=${SYNTHETIC_SECRET}`);
  assert.equal(folded, `api_key=${SYNTHETIC_SECRET}`);
  assert.equal(foldSecurityConfusables(folded), folded);
});

test('Unicode 17 security data is pinned independently of host ICU', async () => {
  assert.deepEqual(SECURITY_UNICODE_17_PROFILE, {
    unicode_version: '17.0.0',
    confusables_sha256: '091c7f82fc39ef208faf8f94d29c244de99254675e09de163160c810d13ef22a',
    derived_core_properties_sha256: '24c7fed1195c482faaefd5c1e7eb821c5ee1fb6de07ecdbaa64b56a99da22c08',
    unicode_data_sha256: '2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c',
    nfkd_entry_count: 5914,
    mark_range_count: 327,
    mark_code_point_count: 2543,
    ascii_confusable_prototype_count: 940,
    maximum_nfkd_utf16_expansion: 18,
    maximum_nfkd_expansion_code_point: 'U+FDFA',
  });
  assert.equal(foldSecurityConfusables('\u{1ACF}'), '');
  assert.equal(foldSecurityConfusables('\uAC01'), '\u1100\u1161\u11A8');
  assert.equal(foldSecurityConfusables('\uFDFA').length, 18);
  for (const confusableSpace of ['\u1680', '\u2028', '\u2029']) {
    assert.equal(foldSecurityConfusables(confusableSpace), ' ');
  }

  const source = await readFile(new URL('../src/util.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.normalize\(['"]NFKD['"]\)/);
  assert.doesNotMatch(source, /\\p\{M\}/);
});

test('structured-key fingerprints fold mixed scripts, marks, and default ignorables', () => {
  const cases = new Map([
    ['\u0430uthority', 'authority'],
    ['auth\u03BFrity', 'authority'],
    ['privileg\u0435', 'privilege'],
    ['private_k\u0435y', 'privatekey'],
    ['parent_m\u0435mory', 'parentmemory'],
    ['api\u200B_key', 'apikey'],
    ['a\u0301uthority', 'authority'],
    ['a\u{1ACF}uthority', 'authority'],
    ['\u00E1uthority', 'authority'],
    ['\u{1D41A}uthority', 'authority'],
  ]);
  for (const [source, expected] of cases) {
    assert.equal(securityKeyFingerprint(source), expected, source);
  }
});

test('secret and serialized-credential scans inspect raw and folded views', () => {
  for (const text of [
    `api_k\u0435y=${SYNTHETIC_SECRET}`,
    `api_k\u00e9y=${SYNTHETIC_SECRET}`,
    `api_ke\u0301y=${SYNTHETIC_SECRET}`,
    `api_k\u{1ACF}ey=${SYNTHETIC_SECRET}`,
    `api_k\u0435y\u2236${SYNTHETIC_SECRET}`,
    `api_k\u0435y\uA789${SYNTHETIC_SECRET}`,
  ]) assert.equal(containsSecretShapedText(text), true, text);
  assert.equal(
    containsSecretShapedText(`B\u0435arer ${SYNTHETIC_SECRET}`),
    true,
  );
  assert.equal(
    containsSerializedCredentialMaterial(`authoriz\u0430tion: Basic ${SYNTHETIC_SECRET}`),
    true,
  );
  assert.equal(
    containsObviousCapabilityLikeText(`B\u0435arer ${SYNTHETIC_SECRET}`),
    true,
  );
});

test('taint telemetry catches confusable prompt and secret patterns without changing policy separation', () => {
  for (const text of [
    'ignor\u0435 previous instructions',
    'ignor\u00e9 previous instructions',
    'ignore\u0301 previous instructions',
    'ignor\u{1ACF}e previous instructions',
    'ignore\u1680previous instructions',
    'ignore\u2028previous instructions',
    'ignore\u2029previous instructions',
  ]) {
    const prompt = scanTaintedValue(text);
    assert.equal(
      prompt.some((finding) => finding.code === 'prompt_injection_pattern'),
      true,
      text,
    );
  }

  const promptAllowed = scanTaintedValue('ignor\u0435 previous instructions', {
    allow_prompt_injection_text: true,
  });
  assert.equal(
    promptAllowed.some((finding) => finding.code === 'prompt_injection_pattern'),
    false,
  );

  const secretAllowed = scanTaintedValue(`api_k\u0435y=${SYNTHETIC_SECRET}`, {
    allow_prompt_injection_text: true,
  });
  assert.equal(secretAllowed.some((finding) => finding.code === 'secret_pattern'), true);
});

test('authority and child-operation boundaries reject confusable protected keys', () => {
  for (const key of [
    '\u0430uthority',
    '\u00e1uthority',
    'a\u0301uthority',
    'a\u{1ACF}uthority',
    'privileg\u0435',
    'private_k\u0435y',
    'api\u200B_key',
  ]) {
    assert.equal(isForbiddenAuthorityShapeKey(key), true, key);
    assert.throws(
      () => validateChildOperation({ [key]: 'opaque' }),
      /authority or secret-bearing field|authority or secret-shaped material/i,
    );
  }
  assert.doesNotThrow(() => validateChildOperation({
    kind: 'analyze',
    options: {
      max_tokens: 100,
      max_output_tokens: 90,
      min_input_tokens: 10,
      output_token_count: 42,
    },
  }));
  for (const key of [
    'max_tokens',
    'max_output_tokens',
    'min_input_tokens',
    'output_token_count',
  ]) assert.equal(isForbiddenAuthorityShapeKey(key), false, key);
  for (const key of [
    'capability_tokens',
    'auth_token',
    'session_token',
    'delegation_token',
    'output_token',
    'input_token',
    'max_token',
    'completion_token',
  ]) assert.equal(isForbiddenAuthorityShapeKey(key), true, key);
});

test('typed-result taint validation rejects a confusable authority key', () => {
  const key = 'authoriz\u0430tion';
  const candidate = {
    type: 'TYPED_RESULT',
    payload: { [key]: 'opaque' },
    payload_schema: {
      type: 'object',
      properties: { [key]: { type: 'string' } },
      required: [key],
      additionalProperties: false,
    },
  };

  assert.throws(
    () => validateCommitCandidate({
      candidate,
      source_fork_id: 'fork-synthetic-confusables',
      validated_at: '2026-09-08T00:00:00.000Z',
    }),
    /authority|secret|taint scan failed/i,
  );

});

test('host imports reject confusable material for every candidate type', () => {
  const secretText = `api_k\u0435y=${SYNTHETIC_SECRET}`;
  const candidates = [
    {
      type: 'TYPED_RESULT',
      payload: { ['authoriz\u0430tion']: 'opaque' },
      payload_schema: {
        type: 'object',
        properties: { ['authoriz\u0430tion']: { type: 'string' } },
        required: ['authoriz\u0430tion'],
        additionalProperties: false,
      },
    },
    {
      type: 'WORKSPACE_DIFF',
      files: [{
        path: 'src/result.txt',
        operation: 'create',
        before_hash: null,
        after_hash: sha256Ref(secretText),
        after_content: secretText,
      }],
      test_evidence: [],
    },
    {
      type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
      action: {
        operation: 'send',
        target_ref: 'target:synthetic',
        provider_ref: 'provider:synthetic',
        arguments: { ['private_k\u0435y']: 'opaque' },
        amount: null,
        currency: null,
        payment_rail: null,
      },
    },
  ];

  for (const candidate of candidates) {
    assert.throws(
      () => createRiskForkImportEnvelope({ candidate }),
      (error) => error?.code === RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_DLP_REJECTED,
      candidate.type,
    );
  }
});

test('clean canonical imports retain original bytes and accept token measurements', () => {
  const original = 'Résumé — Привет, мир.';
  const candidate = {
    type: 'TYPED_RESULT',
    payload: { summary: original, max_tokens: 100 },
    payload_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        max_tokens: { type: 'integer' },
      },
      required: ['summary', 'max_tokens'],
      additionalProperties: false,
    },
  };
  const envelope = createRiskForkImportEnvelope({
    source_fork_ref: 'fork:synthetic-confusables',
    result_hash: sha256Ref(candidate),
    candidate,
  });
  assert.equal(envelope.candidate.payload.summary, original);
  assert.equal(envelope.candidate.payload.max_tokens, 100);
  assert.equal(sha256Ref(envelope.candidate), sha256Ref(candidate));
  assert.notEqual(foldSecurityConfusables(original), original);
});

test('framework caller risk labels reject confusable key spellings', () => {
  const request = {
    schema: RISK_FORK_FRAMEWORK_SCHEMAS.request,
    request_id: 'request:synthetic-confusables',
    framework: 'openai-agents',
    tool_name: 'synthetic_tool',
    descriptor_ref: 'descriptor:synthetic-confusables',
    arguments: { ['r\u0456sk_level']: 'LOW' },
    requested_at: '2026-09-08T00:00:00.000Z',
    request_hash: null,
  };
  request.request_hash = sha256Ref(request);
  assert.throws(
    () => createRiskForkFrameworkToolPlan(request),
    (error) => error?.code === RISK_FORK_FRAMEWORK_DIAGNOSTIC_CODES.ARGUMENTS_INVALID,
  );
});

test('MCP child operations reject confusable secret text before transport', () => {
  const planRequest = {
    schema: RISK_FORK_MCP_PHASE_PLAN_REQUEST_SCHEMA,
    plan_request_id: 'mcp-plan:synthetic-confusables',
    mcp_request_hash: sha256Ref('mcp-request'),
    phase: 'server/discover',
    mcp_server_ref: 'https://example.com/mcp',
    mcp_server_origin: 'https://example.com',
    session_binding_hash: null,
    tool_name: null,
    tool_descriptor_hash: null,
    tool_input_schema: null,
    tool_input_schema_hash: null,
    tool_annotations: null,
    tool_capabilities: null,
    tool_effect_status: null,
    params: { note: `api_k\u0435y=${SYNTHETIC_SECRET}` },
    requested_at: '2026-09-08T00:00:00.000Z',
    plan_request_hash: null,
  };
  planRequest.plan_request_hash = sha256Ref(planRequest);
  assert.throws(
    () => createRiskForkMcpChildOperation(planRequest, {
      response_schema: { type: 'object', additionalProperties: false },
    }),
    /authority|secret/i,
  );
});

test('E2B exact-byte scans reject confusable secret paths and contents', () => {
  function staged(pathValue, content) {
    const bytes = Buffer.from(content, 'utf8');
    return {
      path: pathValue,
      bytes: bytes.byteLength,
      content_hash: sha256Ref(bytes.toString('base64')),
      data_base64: bytes.toString('base64'),
    };
  }

  assert.throws(
    () => scanE2BStagedBytesAuthorityFree([
      staged('input.txt', `api_k\u0435y=${SYNTHETIC_SECRET}`),
    ]),
    /authority|secret/i,
  );
  assert.throws(
    () => scanE2BStagedBytesAuthorityFree([
      staged('private_k\u0435y.txt', 'sanitized content'),
    ]),
    /secret-shaped path/i,
  );
  assert.doesNotThrow(() => scanE2BStagedBytesAuthorityFree([
    staged('résumé.txt', 'Привет, мир.'),
  ]));
});

test('immutable E2B workspace export rejects confusable secret bytes before copying', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-confusables-'));
  const source = path.join(root, 'source');
  const exportRoot = path.join(root, 'exports');
  await mkdir(source);
  await writeFile(path.join(source, 'input.txt'), `api_k\u0435y=${SYNTHETIC_SECRET}\n`);
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    createImmutableWorkspaceExport({
      source_workspace: source,
      export_root: exportRoot,
      export_id: 'confusable_scan',
      expected_workspace_digest: sha256Ref('must-not-reach-copy'),
    }),
    /credential|secret/i,
  );
});

test('hackathon operation gate folds demo-only secret field names', () => {
  assert.throws(
    () => validateDemoOperation({
      kind: 'bounded_file_batch',
      actions: [{
        type: 'read',
        path: 'workspace/result.txt',
        ['cook\u0456e']: 'opaque',
      }],
      commit_candidate: null,
    }),
    /secret|credential/i,
  );
});

test('MCP host and stdio client raw scans stay wired to shared folded detectors', async () => {
  const [mcpHostSource, clientGateSource] = await Promise.all([
    readFile(new URL('../src/mcp-host-adapter.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../clients/one-tool-stdio-gate.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(
    mcpHostSource,
    /function scanSecretValues[\s\S]+containsSecretShapedText\(current\)/,
  );
  assert.match(
    clientGateSource,
    /function normalizedKey[\s\S]+foldSecurityConfusables\(value\)/,
  );
  assert.match(
    clientGateSource,
    /function containsCredentialMaterial[\s\S]+containsSerializedCredentialMaterial\(value\)/,
  );
});

test('benign multilingual free text remains accepted by the detector', () => {
  assert.deepEqual(scanTaintedValue('Bonjour le monde — résumé du café. Привет, мир.'), []);
  const maximumNfkdExpansion = '\uFDFA'.repeat(4);
  assert.equal(foldSecurityConfusables(maximumNfkdExpansion).length, 72);
  assert.deepEqual(scanTaintedValue(maximumNfkdExpansion), []);
});
