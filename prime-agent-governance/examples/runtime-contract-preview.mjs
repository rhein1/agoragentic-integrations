import {
  buildPrimeAgentIntegrationDescriptor,
  buildPrimeAgentRuntimeRequest,
} from '../runtime-contract.mjs';

const runtimeRequest = buildPrimeAgentRuntimeRequest({
  owner_id: 'owner-example',
  workspace_id: 'workspace-example',
  deployment_id: 'deployment-example',
  principal_ref: 'principal:owner-example',
  goal: 'Inspect the repository and return a bounded evidence summary.',
  sandbox_profile_ref: 'sandbox:agent-os-restricted-v1',
  harness_policy_ref: 'policy:prime-agent-example-v1',
  authority_ref: 'authority:prime-agent-example-v1',
  model_ref: 'model:gpt-5.6',
  provider_ref: 'provider:openai',
  credential_profile_ref: 'credential-profile:prime-agent-example-v1',
  runtime_image_ref: 'image:prime-agent-v0.7.1-restricted',
  runtime_image_digest: `sha256:${'1'.repeat(64)}`,
  extension_integrity_ref: `sha256:${'2'.repeat(64)}`,
});

console.log(JSON.stringify({
  integration: buildPrimeAgentIntegrationDescriptor(),
  runtime_request: runtimeRequest,
}, null, 2));
