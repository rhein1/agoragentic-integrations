import { deepFreeze, requireEnum, requireString } from './util.mjs';

export const REQUIRED_PROVIDER_METHODS = Object.freeze([
  'createSavepoint',
  'createFork',
  'getForkStatus',
  'executeInFork',
  'collectEvidence',
  'collectDiff',
  'suspendFork',
  'destroyFork',
  'verifyDestroyed',
  'destroySavepoint',
  'verifySavepointDestroyed',
]);

export class RiskForkProvider {
  constructor({ id, capabilities }) {
    this.id = requireString(id, 'provider id', { maxLength: 200 });
    this.capabilities = deepFreeze({
      supports_memory_snapshot: capabilities?.supports_memory_snapshot === true,
      supports_filesystem_snapshot: capabilities?.supports_filesystem_snapshot === true,
      supports_live_fork: capabilities?.supports_live_fork === true,
      supports_network_policy: capabilities?.supports_network_policy === true,
      supports_egress_allowlist: capabilities?.supports_egress_allowlist === true,
      supports_runtime_attestation: capabilities?.supports_runtime_attestation === true,
      supports_suspend_resume: capabilities?.supports_suspend_resume === true,
      supports_verified_destruction: capabilities?.supports_verified_destruction === true,
      supports_hard_ttl: capabilities?.supports_hard_ttl === true,
      supports_idle_ttl: capabilities?.supports_idle_ttl === true,
      supports_max_execution_time: capabilities?.supports_max_execution_time === true,
      supports_automatic_credential_expiry:
        capabilities?.supports_automatic_credential_expiry === true,
      child_credentials_mode: requireEnum(
        capabilities?.child_credentials_mode ?? 'unknown',
        ['prohibited', 'scoped_expiring', 'unknown'],
        'capabilities.child_credentials_mode',
      ),
      isolation_class: requireString(
        capabilities?.isolation_class ?? 'unknown',
        'capabilities.isolation_class',
        { maxLength: 100 },
      ),
      adapter_implementation: requireString(
        capabilities?.adapter_implementation ?? 'unknown',
        'capabilities.adapter_implementation',
        { maxLength: 100 },
      ),
      mock_conformance: requireString(
        capabilities?.mock_conformance ?? 'unknown',
        'capabilities.mock_conformance',
        { maxLength: 100 },
      ),
      credentialed_provider_validation: requireString(
        capabilities?.credentialed_provider_validation ?? 'not_run',
        'capabilities.credentialed_provider_validation',
        { maxLength: 100 },
      ),
      containment_claim: requireString(
        capabilities?.containment_claim ?? 'not_verified',
        'capabilities.containment_claim',
        { maxLength: 100 },
      ),
    });
  }

  async createSavepoint() { throw new Error(`${this.id}.createSavepoint is not implemented`); }

  async createFork() { throw new Error(`${this.id}.createFork is not implemented`); }

  async getForkStatus() { throw new Error(`${this.id}.getForkStatus is not implemented`); }

  async executeInFork() { throw new Error(`${this.id}.executeInFork is not implemented`); }

  async collectEvidence() { throw new Error(`${this.id}.collectEvidence is not implemented`); }

  async collectDiff() { throw new Error(`${this.id}.collectDiff is not implemented`); }

  async suspendFork() { throw new Error(`${this.id}.suspendFork is not implemented`); }

  async destroyFork() { throw new Error(`${this.id}.destroyFork is not implemented`); }

  async verifyDestroyed() { throw new Error(`${this.id}.verifyDestroyed is not implemented`); }

  async destroySavepoint() { throw new Error(`${this.id}.destroySavepoint is not implemented`); }

  async verifySavepointDestroyed() {
    throw new Error(`${this.id}.verifySavepointDestroyed is not implemented`);
  }
}

export function assertRiskForkProvider(provider) {
  if (!provider || typeof provider !== 'object') throw new TypeError('provider must be an object');
  requireString(provider.id, 'provider.id');
  if (!provider.capabilities || typeof provider.capabilities !== 'object') {
    throw new TypeError('provider.capabilities is required');
  }
  for (const method of REQUIRED_PROVIDER_METHODS) {
    if (typeof provider[method] !== 'function') {
      throw new TypeError(`provider.${method} must be a function`);
    }
  }
  return provider;
}

export function requireProviderCapability(provider, capability) {
  assertRiskForkProvider(provider);
  if (provider.capabilities[capability] !== true) {
    throw new Error(`Provider ${provider.id} does not support ${capability}`);
  }
}
