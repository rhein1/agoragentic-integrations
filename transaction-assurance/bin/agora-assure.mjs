#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  buildAuthorityRequest,
  buildTransactionAssuranceEnvelope,
  canonicalize,
  detectAuthorityProtocol,
  evaluateTransactionAssuranceEnvelope,
  normalizeAuthorityArtifact,
  sha256Ref,
} from '../src/index.mjs';

function usage() {
  return `Agoragentic Transaction Assurance (local/no-network)

Usage:
  agora-assure detect <artifact.json> [--protocol <id>]
  agora-assure normalize <artifact.json> [--protocol <id>] [--artifact-ref <ref>] [--verification-status <status>] [--verification-ref <ref>] [--revocation-status <status>]
  agora-assure authority-request <input.json>
  agora-assure envelope <input.json>
  agora-assure evaluate <envelope.json> [--phase pre_execution|post_execution] [--now <ISO date>]
  agora-assure canonicalize <input.json>
  agora-assure hash <input.json>
  agora-assure self-test

The CLI never calls a network, signs a payment, moves money, creates a wallet,
approves authority, deploys, publishes, or mutates marketplace trust.
`;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson(file) {
  if (!file) throw new TypeError('A JSON file path is required');
  const resolved = path.resolve(process.cwd(), file);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function selfTest() {
  const artifact = {
    schema: 'agoragentic.agent-commerce.mandate.v1',
    owner_id: 'owner:self-test',
    buyer_agent_id: 'agent:self-test',
    issued_at: '2026-08-06T00:00:00Z',
    expires_at: '2026-08-07T00:00:00Z',
    scope: {
      allowed_actions: ['execute:research'],
      allowed_sellers: ['seller:self-test'],
      allowed_categories: ['research'],
      allowed_payment_rails: ['x402'],
    },
    budget: {
      currency: 'USDC',
      max_per_action: '0.10',
      max_daily: '1.00',
      max_total: '5.00',
    },
  };

  const normalizedAuthority = normalizeAuthorityArtifact(artifact, {
    artifactRef: 'fixture:self-test-mandate',
    verification: {
      status: 'verified',
      verifierRef: 'fixture:self-test-verifier',
      evidenceRef: 'fixture:self-test-signature-proof',
      checkedAt: '2026-08-06T00:00:01Z',
    },
    revocationStatus: 'active',
  });

  const envelope = buildTransactionAssuranceEnvelope({
    createdAt: '2026-08-06T00:01:00Z',
    updatedAt: '2026-08-06T00:01:00Z',
    now: '2026-08-06T00:01:00Z',
    principalRef: 'owner:self-test',
    principalType: 'human',
    principalIdentityVerification: 'verified',
    agentRef: 'agent:self-test',
    agentIdentityVerification: 'verified',
    normalizedAuthority,
    commercialIntent: {
      action: 'execute:research',
      taskRef: 'task:self-test',
      sellerRef: 'seller:self-test',
      capabilityRef: 'capability:self-test',
      category: 'research',
      quoteRef: 'quote:self-test',
      quoteHash: sha256Ref({ amount: '0.05', currency: 'USDC' }),
      quotedAmount: '0.05',
      currency: 'USDC',
      termsRef: 'terms:self-test',
      termsHash: sha256Ref({ delivery: 'json', timeout_ms: 30000 }),
      termsMatchStatus: 'match',
    },
    payment: {
      paymentIdentifier: 'payment:self-test',
      rail: 'x402',
      status: 'not_started',
      amount: '0.05',
      currency: 'USDC',
    },
    execution: {
      idempotencyKeyHash: sha256Ref('self-test-idempotency'),
      inputHash: sha256Ref({ query: 'self-test' }),
    },
    outcome: {
      verificationScope: 'No outcome yet; pre-execution self-test.',
      unknowns: ['Payment and execution have not started.'],
    },
  });

  const evaluation = evaluateTransactionAssuranceEnvelope(envelope, {
    phase: 'pre_execution',
    now: '2026-08-06T00:01:01Z',
  });

  if (evaluation.decision !== 'allow') {
    throw new Error(`Self-test expected allow, received ${evaluation.decision}: ${evaluation.blockers.join(', ')}`);
  }

  return {
    ok: true,
    protocol: normalizedAuthority.source_protocol,
    state: envelope.state,
    decision: evaluation.decision,
    no_network: true,
    no_spend: true,
    authority_granted_by_cli: false,
  };
}

function main() {
  const [command, file] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(usage());
    return;
  }

  switch (command) {
    case 'detect': {
      const artifact = readJson(file);
      print(detectAuthorityProtocol(artifact, { protocolHint: option('--protocol') }));
      return;
    }
    case 'normalize': {
      const artifact = readJson(file);
      print(normalizeAuthorityArtifact(artifact, {
        protocolHint: option('--protocol'),
        artifactRef: option('--artifact-ref'),
        revocationStatus: option('--revocation-status'),
        verification: {
          status: option('--verification-status') || 'unverified',
          evidenceRef: option('--verification-ref'),
          verifierRef: option('--verifier-ref'),
          checkedAt: option('--checked-at'),
        },
      }));
      return;
    }
    case 'authority-request':
      print(buildAuthorityRequest(readJson(file)));
      return;
    case 'envelope':
      print(buildTransactionAssuranceEnvelope(readJson(file)));
      return;
    case 'evaluate':
      print(evaluateTransactionAssuranceEnvelope(readJson(file), {
        phase: option('--phase') || 'pre_execution',
        now: option('--now'),
      }));
      return;
    case 'canonicalize':
      process.stdout.write(`${canonicalize(readJson(file))}\n`);
      return;
    case 'hash':
      process.stdout.write(`${sha256Ref(readJson(file))}\n`);
      return;
    case 'self-test':
      print(selfTest());
      return;
    default:
      throw new TypeError(`Unknown command: ${command}\n\n${usage()}`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`agora-assure: ${error.message}\n`);
  process.exitCode = 1;
}
