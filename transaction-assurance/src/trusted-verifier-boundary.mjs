const authorityBindings = new WeakMap();
const envelopeBindings = new WeakMap();

function binding(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  if (value.trust_mode !== 'trusted_callback') {
    throw new TypeError(`${field}.trust_mode must be trusted_callback`);
  }
  if (typeof value.verifier_ref !== 'string' || !value.verifier_ref.trim()) {
    throw new TypeError(`${field}.verifier_ref is required`);
  }
  if (typeof value.binding_hash !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(value.binding_hash)) {
    throw new TypeError(`${field}.binding_hash must be a sha256 reference`);
  }
  if (typeof value.artifact_hash !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(value.artifact_hash)) {
    throw new TypeError(`${field}.artifact_hash must be a sha256 reference`);
  }
  return Object.freeze({
    trust_mode: 'trusted_callback',
    verifier_ref: value.verifier_ref.trim(),
    binding_hash: value.binding_hash,
    artifact_hash: value.artifact_hash,
  });
}

export function bindTrustedAuthority(authority, value) {
  authorityBindings.set(authority, binding(value, 'authorityBinding'));
  return authority;
}

export function trustedAuthorityBinding(authority) {
  return authorityBindings.get(authority) || null;
}

export function bindTrustedEnvelope(envelope, value) {
  envelopeBindings.set(envelope, binding(value, 'envelopeBinding'));
  return envelope;
}

export function trustedEnvelopeBinding(envelope) {
  return envelopeBindings.get(envelope) || null;
}
