import { writeSync } from 'node:fs';

import { PostgresDistributedCommitAuthority } from '../../src/adapters/postgres-authority.mjs';
import { sha256Ref } from '../../src/canonical.mjs';

let serialized = '';
for await (const chunk of process.stdin) serialized += chunk;
const input = JSON.parse(serialized);

function write(value) {
  writeSync(process.stdout.fd, `${JSON.stringify(value)}\n`);
}

function authorizationProof(request) {
  return {
    schema: 'agoragentic.risk-fork.distributed-authorization-verification.v1',
    status: 'verified',
    verification_request_hash: request.verification_request_hash,
    authorization_id: request.authorization_id,
    authorization_ref: request.authorization_ref,
    authorization_hash: request.authorization_hash,
    binding_hash: request.binding_hash,
    signature_status: 'verified',
    integrity_status: 'verified',
    exact_binding_status: 'verified',
    evidence_ref: 'worker-verifier:authorization',
    evidence_hash: sha256Ref('worker-verifier:authorization'),
  };
}

const authority = new PostgresDistributedCommitAuthority({
  connectionString: input.connection_string,
  authorityId: input.authority_id,
  schemaName: input.schema_name,
  verifyAuthorizationIntegrity: async (request) => authorizationProof(request),
});

try {
  await authority.initialize();
  const operation = await authority.runCommit(input.request, {
    claimant_ref: input.claimant_ref,
    verifyUnderReservation: async (request) => ({
      schema: 'agoragentic.risk-fork.distributed-final-gate-verification.v1',
      status: 'verified',
      request_hash: request.request_hash,
      authority_request_hash: request.authority_request_hash,
      governance_hash: request.governance_hash,
    }),
    performEffect: ({ effect_key: effectKey }) => {
      write({ type: 'effect_invoked', effect_key: effectKey });
      if (input.mode === 'crash_after_effect_claim') process.exit(72);
      return { outcome: 'worker-effect', effect_key: effectKey };
    },
  });
  write({
    type: 'finished',
    ok: true,
    status: operation.status,
    operation_ref: operation.operation_ref,
    idempotent: operation.idempotent,
  });
} catch (error) {
  write({
    type: 'finished',
    ok: false,
    code: error?.code ?? error?.name ?? 'UNKNOWN',
    operation_ref: error?.evidence?.operation_ref ?? null,
  });
} finally {
  await authority.close();
}
