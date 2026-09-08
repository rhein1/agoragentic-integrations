import { isProxy } from 'node:util/types';
import {
  assertRiskForkProvider,
  REQUIRED_PROVIDER_METHODS,
} from '../../src/provider.mjs';
import { sha256Ref } from '../../src/canonical.mjs';
import {
  assertAllowedKeys,
  assertDataArray,
  assertPlainRecord,
  cloneJson,
  deepFreeze,
  managedError,
  requireEnum,
  requireProviderId,
  requireSha256,
  requireTenantId,
} from './validation.mjs';

function requireOwnDataProperty(value, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError(`${label}.${key} must be an own data property`);
  }
  return descriptor.value;
}

function requireProviderMethod(value, method) {
  let cursor = value;
  while (cursor !== null) {
    if (isProxy(cursor)) throw new TypeError('provider and its prototype chain must not be Proxy');
    const descriptor = Object.getOwnPropertyDescriptor(cursor, method);
    if (descriptor) {
      if (!Object.hasOwn(descriptor, 'value')
        || typeof descriptor.value !== 'function'
        || isProxy(descriptor.value)) {
        throw new TypeError(`provider.${method} must be a non-Proxy data function`);
      }
      return descriptor.value;
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  throw new TypeError(`provider.${method} must be a function`);
}

function inspectProvider(value) {
  if (!value || typeof value !== 'object' || isProxy(value)) {
    throw new TypeError('provider must be a non-Proxy object');
  }
  const providerId = requireProviderId(
    requireOwnDataProperty(value, 'id', 'provider'),
    'provider.id',
  );
  const capabilitiesValue = requireOwnDataProperty(value, 'capabilities', 'provider');
  assertPlainRecord(capabilitiesValue, 'provider.capabilities');
  const capabilities = deepFreeze(cloneJson(capabilitiesValue, 'provider.capabilities'));
  const methods = Object.fromEntries(
    REQUIRED_PROVIDER_METHODS.map((method) => [method, requireProviderMethod(value, method)]),
  );
  return { provider_id: providerId, capabilities, methods };
}

function captureProvider(value) {
  const inspected = inspectProvider(value);
  const capabilitiesHash = sha256Ref(inspected.capabilities);
  function assertStable() {
    let current;
    try {
      current = inspectProvider(value);
    } catch {
      throw managedError(
        'Provider implementation no longer matches its registered binding',
        'PROVIDER_BINDING_DRIFT',
        503,
      );
    }
    const methodsStable = REQUIRED_PROVIDER_METHODS.every(
      (method) => current.methods[method] === inspected.methods[method],
    );
    if (current.provider_id !== inspected.provider_id
      || sha256Ref(current.capabilities) !== capabilitiesHash
      || !methodsStable) {
      throw managedError(
        'Provider implementation no longer matches its registered binding',
        'PROVIDER_BINDING_DRIFT',
        503,
      );
    }
  }
  const facade = {
    id: inspected.provider_id,
    capabilities: inspected.capabilities,
  };
  for (const method of REQUIRED_PROVIDER_METHODS) {
    const implementation = inspected.methods[method];
    facade[method] = async (...args) => {
      assertStable();
      let result;
      try {
        result = await Reflect.apply(implementation, value, args);
      } catch (error) {
        try {
          assertStable();
        } catch (driftError) {
          throw driftError;
        }
        throw error;
      }
      assertStable();
      return result;
    };
  }
  assertRiskForkProvider(facade);
  return {
    provider: deepFreeze(facade),
    capabilities_hash: capabilitiesHash,
    assert_stable: assertStable,
  };
}

function normalizeRegistration(value) {
  assertPlainRecord(value, 'provider registration');
  assertAllowedKeys(value, [
    'provider',
    'enabled',
    'adapter_digest',
    'qualification_class',
    'qualification_receipt_hash',
    'tenant_ids',
    'verify_resource_binding',
    'verify_cleanup_evidence',
    'verify_recovery_absence',
  ], 'provider registration');
  const capturedProvider = captureProvider(value.provider);
  const provider = capturedProvider.provider;
  const providerId = requireProviderId(provider.id, 'provider.id');
  if (typeof value.enabled !== 'boolean') {
    throw new TypeError('provider registration.enabled must be a boolean');
  }
  if (typeof value.verify_cleanup_evidence !== 'function') {
    throw new TypeError('provider registration.verify_cleanup_evidence must be a function');
  }
  if (typeof value.verify_resource_binding !== 'function') {
    throw new TypeError('provider registration.verify_resource_binding must be a function');
  }
  if (typeof value.verify_recovery_absence !== 'function') {
    throw new TypeError('provider registration.verify_recovery_absence must be a function');
  }
  const qualificationClass = requireEnum(
    value.qualification_class,
    ['local_test'],
    'provider registration.qualification_class',
  );
  assertDataArray(value.tenant_ids, 'provider registration.tenant_ids', { maxLength: 10_000 });
  if (value.tenant_ids.length === 0) {
    throw new TypeError('provider registration.tenant_ids must be non-empty');
  }
  const tenantIds = [...new Set(value.tenant_ids.map((tenantId) => requireTenantId(tenantId)))];
  if (tenantIds.length !== value.tenant_ids.length) {
    throw new TypeError('provider registration.tenant_ids must be unique');
  }
  tenantIds.sort();
  const adapterDigest = requireSha256(value.adapter_digest, 'provider registration.adapter_digest');
  const qualificationReceiptHash = requireSha256(
    value.qualification_receipt_hash,
    'provider registration.qualification_receipt_hash',
  );
  const providerBindingHash = sha256Ref({
    provider_id: providerId,
    adapter_digest: adapterDigest,
    capabilities: provider.capabilities,
    qualification_class: qualificationClass,
    qualification_receipt_hash: qualificationReceiptHash,
    tenant_ids: tenantIds,
  });
  return {
    provider,
    assert_provider_stable: capturedProvider.assert_stable,
    provider_id: providerId,
    enabled: value.enabled,
    adapter_digest: adapterDigest,
    provider_binding_hash: providerBindingHash,
    qualification_class: qualificationClass,
    qualification_receipt_hash: qualificationReceiptHash,
    tenant_ids: tenantIds,
    verify_resource_binding: value.verify_resource_binding,
    verify_cleanup_evidence: value.verify_cleanup_evidence,
    verify_recovery_absence: value.verify_recovery_absence,
  };
}

function publicBinding(registration) {
  return deepFreeze({
    provider_id: registration.provider_id,
    provider_binding_hash: registration.provider_binding_hash,
    provider_adapter_digest: registration.adapter_digest,
    provider_qualification_receipt_hash: registration.qualification_receipt_hash,
    qualification_class: registration.qualification_class,
  });
}

export function createManagedProviderRegistry(registrations = []) {
  assertDataArray(registrations, 'provider registrations', { maxLength: 1_000 });
  const entries = new Map();
  for (const value of registrations) {
    const registration = normalizeRegistration(value);
    const registrationKey = `${registration.provider_id}\u0000${registration.provider_binding_hash}`;
    if (entries.has(registrationKey)) {
      throw new TypeError(`provider binding ${registration.provider_id} is registered more than once`);
    }
    entries.set(registrationKey, registration);
  }
  const enabledTenantBindings = new Set();
  for (const registration of entries.values()) {
    if (!registration.enabled) continue;
    for (const tenantId of registration.tenant_ids) {
      const key = `${registration.provider_id}\u0000${tenantId}`;
      if (enabledTenantBindings.has(key)) {
        throw new TypeError(
          `provider ${registration.provider_id} has multiple enabled bindings for one tenant`,
        );
      }
      enabledTenantBindings.add(key);
    }
  }
  function requireRegistration(providerIdValue, tenantIdValue, bindingHashValue, allowDisabled) {
    const providerId = requireProviderId(providerIdValue);
    const tenantId = requireTenantId(tenantIdValue);
    let matches;
    if (bindingHashValue === undefined) {
      matches = [...entries.values()].filter((entry) => entry.provider_id === providerId
        && entry.enabled
        && entry.tenant_ids.includes(tenantId));
    } else {
      const bindingHash = requireSha256(bindingHashValue, 'provider_binding_hash');
      const exact = entries.get(`${providerId}\u0000${bindingHash}`);
      matches = exact && exact.tenant_ids.includes(tenantId) && (allowDisabled || exact.enabled)
        ? [exact]
        : [];
    }
    if (matches.length !== 1) {
      throw managedError(
        'No exactly bound locally qualified provider is available for this tenant',
        'PROVIDER_NOT_ELIGIBLE',
        503,
      );
    }
    matches[0].assert_provider_stable();
    return matches[0];
  }
  return Object.freeze({
    requireEligible(providerIdValue, tenantIdValue) {
      return requireRegistration(providerIdValue, tenantIdValue, undefined, false).provider;
    },
    admissionBinding(providerIdValue, tenantIdValue) {
      return publicBinding(requireRegistration(providerIdValue, tenantIdValue, undefined, false));
    },
    requireBound(providerIdValue, tenantIdValue, bindingHashValue, { allowDisabled = false } = {}) {
      if (typeof allowDisabled !== 'boolean') throw new TypeError('allowDisabled must be a boolean');
      return requireRegistration(
        providerIdValue,
        tenantIdValue,
        bindingHashValue,
        allowDisabled,
      ).provider;
    },
    hasBound(providerIdValue, tenantIdValue, bindingHashValue, { allowDisabled = true } = {}) {
      if (typeof allowDisabled !== 'boolean') throw new TypeError('allowDisabled must be a boolean');
      try {
        requireRegistration(
          providerIdValue,
          tenantIdValue,
          bindingHashValue,
          allowDisabled,
        );
        return true;
      } catch {
        return false;
      }
    },
    async verifyResourceBinding({
      provider_id: providerIdValue,
      tenant_id: tenantIdValue,
      provider_binding_hash: bindingHashValue,
      resources,
      context,
      allow_disabled: allowDisabled = false,
    } = {}) {
      const tenantId = requireTenantId(tenantIdValue);
      const registration = requireRegistration(
        providerIdValue,
        tenantId,
        bindingHashValue,
        allowDisabled,
      );
      let verified = false;
      try {
        verified = await registration.verify_resource_binding(deepFreeze({
          tenant_id: tenantId,
          resources,
          context,
          binding: publicBinding(registration),
        }));
      } catch {
        verified = false;
      }
      registration.assert_provider_stable();
      if (verified !== true) {
        throw managedError(
          'Provider resource binding attestation failed closed',
          'RESOURCE_BINDING_ATTESTATION_FAILED',
          409,
        );
      }
      return sha256Ref({
        tenant_id: tenantId,
        provider_binding_hash: registration.provider_binding_hash,
        provider_recovery_key: resources.provider_recovery_key,
        savepoint_ref: resources.savepoint_ref,
        fork_ref: resources.fork_ref,
        absent_resource_kinds: resources.absent_resource_kinds,
        invocation_ref: context.invocation_ref,
        recovery_mode: context.recovery_mode,
        verification_class: 'local_test_adapter_verified',
      });
    },
    async verifyCleanupEvidence({
      provider_id: providerIdValue,
      tenant_id: tenantIdValue,
      provider_binding_hash: bindingHashValue,
      evidence,
      request,
      context,
    } = {}) {
      const tenantId = requireTenantId(tenantIdValue);
      const registration = requireRegistration(
        providerIdValue,
        tenantId,
        bindingHashValue,
        true,
      );
      let verified = false;
      try {
        verified = await registration.verify_cleanup_evidence(deepFreeze({
          tenant_id: tenantId,
          evidence,
          request,
          context,
          binding: publicBinding(registration),
        }));
      } catch {
        verified = false;
      }
      registration.assert_provider_stable();
      if (verified !== true) {
        throw managedError(
          'Provider cleanup attestation failed closed',
          'CLEANUP_PROVIDER_ATTESTATION_FAILED',
          409,
        );
      }
      return sha256Ref({
        tenant_id: tenantId,
        provider_binding_hash: registration.provider_binding_hash,
        provider_recovery_key: context.provider_recovery_key,
        savepoint_ref: context.savepoint_ref,
        fork_ref: context.fork_ref,
        cleanup_request_hash: request.request_hash,
        evidence_hash: evidence.evidence_hash,
        verification_class: 'local_test_adapter_verified',
      });
    },
    async verifyRecoveryAbsence({
      provider_id: providerIdValue,
      tenant_id: tenantIdValue,
      provider_binding_hash: bindingHashValue,
      evidence,
      context,
    } = {}) {
      const tenantId = requireTenantId(tenantIdValue);
      const registration = requireRegistration(
        providerIdValue,
        tenantId,
        bindingHashValue,
        true,
      );
      let verified = false;
      try {
        verified = await registration.verify_recovery_absence(deepFreeze({
          tenant_id: tenantId,
          evidence,
          context,
          binding: publicBinding(registration),
        }));
      } catch {
        verified = false;
      }
      registration.assert_provider_stable();
      if (verified !== true) {
        throw managedError(
          'Provider recovery absence attestation failed closed',
          'RECOVERY_ABSENCE_ATTESTATION_FAILED',
          409,
        );
      }
      return sha256Ref({
        tenant_id: tenantId,
        provider_binding_hash: registration.provider_binding_hash,
        provider_recovery_key: evidence.provider_recovery_key,
        recovery_evidence_hash: sha256Ref(evidence),
        verification_class: 'local_test_adapter_verified',
      });
    },
    hasEligibleProvider(tenantIdValue) {
      const tenantId = requireTenantId(tenantIdValue);
      return [...entries.values()].some(
        (entry) => {
          if (!entry.enabled || !entry.tenant_ids.includes(tenantId)) return false;
          try {
            entry.assert_provider_stable();
            return true;
          } catch {
            return false;
          }
        },
      );
    },
    summary() {
      const stableEntries = [...entries.values()].filter((entry) => {
        try {
          entry.assert_provider_stable();
          return true;
        } catch {
          return false;
        }
      });
      return deepFreeze({
        provider_count: stableEntries.filter((entry) => entry.enabled).length,
        registered_provider_count: entries.size,
        provider_binding_integrity: stableEntries.length === entries.size,
        qualification_class: stableEntries.length > 0 ? 'local_test' : 'none',
        production_provider_count: 0,
      });
    },
  });
}
