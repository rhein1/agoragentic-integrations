import fs from 'node:fs';
import {
  buildTransactionAssuranceEnvelope,
  evaluateTransactionAssuranceEnvelope,
  normalizeAuthorityArtifact,
  sha256Ref,
} from '../src/index.mjs';

const artifact = JSON.parse(fs.readFileSync(new URL('./native-mandate.json', import.meta.url), 'utf8'));

const normalizedAuthority = normalizeAuthorityArtifact(artifact, {
  artifactRef: 'file:examples/native-mandate.json',
  verification: {
    status: 'verified',
    verifierRef: 'example:fixture-verifier',
    evidenceRef: 'example:fixture-signature-evidence',
    checkedAt: '2026-08-06T00:00:01Z',
  },
  revocationStatus: 'active',
});

const envelope = buildTransactionAssuranceEnvelope({
  createdAt: '2026-08-06T00:01:00Z',
  updatedAt: '2026-08-06T00:01:00Z',
  now: '2026-08-06T00:01:00Z',
  principalRef: 'owner:example',
  principalType: 'human',
  principalIdentityVerification: 'verified',
  agentRef: 'agent:example-research-buyer',
  agentUri: 'agent://example-research-buyer',
  agentIdentityVerification: 'verified',
  normalizedAuthority,
  commercialIntent: {
    action: 'execute:research',
    taskRef: 'task:example-brief',
    sellerRef: 'seller:example',
    capabilityRef: 'capability:example-research',
    category: 'research',
    quoteRef: 'quote:example',
    quoteHash: sha256Ref({ amount: '0.05', currency: 'USDC' }),
    quotedAmount: '0.05',
    currency: 'USDC',
    termsRef: 'terms:example',
    termsHash: sha256Ref({ format: 'json', max_latency_ms: 30000 }),
    termsMatchStatus: 'match',
  },
  payment: {
    paymentIdentifier: 'payment:example',
    rail: 'x402',
    amount: '0.05',
    currency: 'USDC',
  },
  execution: {
    idempotencyKeyHash: sha256Ref('private-example-idempotency-key'),
    inputHash: sha256Ref({ query: 'example bounded research request' }),
  },
  outcome: {
    verificationScope: 'No execution has occurred; this is a pre-execution example.',
    unknowns: ['Payment and execution have not started.'],
  },
});

const evaluation = evaluateTransactionAssuranceEnvelope(envelope, {
  phase: 'pre_execution',
  now: '2026-08-06T00:01:01Z',
});

console.log(JSON.stringify({ envelope, evaluation }, null, 2));
