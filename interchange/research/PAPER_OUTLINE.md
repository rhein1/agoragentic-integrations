# Suggested Research Paper Outline

## Working title

**From Discoverability to Authority: Production Lessons from an Agent Commerce
Interchange Using A2A, x402, Receipts, and Principal-Controlled Consent**

Alternative: **Building an Agent Commerce Interchange in Production: Payment,
Federation, Evidence, and the Cost of Conflating Discovery with Authority**

## Abstract shape

State the problem: existing agent discovery, task RPC, and payment protocols each
cover only part of cross-operator agent commerce. Describe the implemented
Interchange as four planes:

1. discovery;
2. control and authority;
3. money and settlement; and
4. proof, receipts, and reconciliation.

Report the strongest positive results: a 12-state governed lifecycle, a live
outbound x402 canary to a third-party seller, a recruited external buyer's
own-wallet CAIP-2 payment on Base, and an independent Anchor key-control plus
bounded capability-exchange pilot. Report the strongest negative result with
equal prominence: a week-long bounded outreach observation produced no valid
A2A engagement because discoverable targets generally lacked live consent,
compatible protocol bindings, valid cards, or reachable endpoints.

End with the principal lesson: **discoverability is evidence about where an
agent may be found; it is not authority to contact, invoke, route, spend, or
trust.**

## Research questions

1. Can a marketplace carry a transaction from discovery through governed
   execution, settlement, receipt verification, and reconciliation without
   merging identity, payer, and principal authority?
2. What interoperability failures appear when current x402 clients, A2A cards,
   registries, relays, and operator workflows meet production constraints?
3. Which evidence distinguishes source completion, deployment, activation,
   external interoperability, adoption, and revenue?
4. Can autonomous cross-operator outreach remain safe without treating registry
   inclusion as consent?
5. What minimum authority and evidence overlays are needed above discovery and
   task-RPC protocols?

## Proposed sections

### 1. Background

- A2A as task-oriented initiator-to-responder RPC.
- x402 as HTTP-native payment challenge and retry.
- registries and Agent Cards as discovery/provenance surfaces.
- the missing cross-cutting concerns: consent, payer/principal separation,
  durable evidence, revocation, and operator control.

### 2. Interchange architecture

- 12-state transaction plan lifecycle.
- capability cards and mandates.
- internal-balance and x402-per-request rails.
- Arbiter review, settlement evidence, signed receipts, and reconciliation.
- principal authority grants and reserved-wallet authority.
- federation identity keys, TOFU pinning, challenge response, and capability
  exchange.

### 3. Method and evidence taxonomy

- action-research / production engineering case-study framing.
- recruited versus organic actors.
- no-spend probes versus paid calls.
- source, deploy, activation, external exercise, adoption, and revenue levels.
- public and private evidence boundaries.

### 4. x402 production case study

- canonical challenge compatibility.
- outbound external-seller canary.
- governed internal-balance pilot.
- authenticated own-wallet buyer identity.
- dual Base / CAIP-2 endpoint design.
- stock modern-client settlement.
- signer mismatch, custody freeze, CDP migration, and fail-closed availability.

### 5. A2A and federation case study

- reciprocal operator consent and dedicated identity keys.
- relay auth, challenge lifetime, transactional storage, and hash recipes.
- bounded capability exchange and catalog-shape pluralism.
- autonomous first-contact observation and zero-engagement result.
- correspondence relay and consented inbound intake as separate lanes.

### 6. Production findings

Group findings by:

- protocol-shape mismatches;
- money safety and idempotency;
- identity and authority binding;
- deploy/configuration drift;
- evidence reproducibility;
- discovery-source quality; and
- human/operator coordination.

Use [`PRODUCTION_FINDINGS.md`](./PRODUCTION_FINDINGS.md) as the source table.

### 7. Results

Separate:

- implemented capability;
- deployed and activated behavior;
- first-party proof;
- recruited external interoperability;
- independent external federation evidence;
- organic adoption; and
- retained revenue.

### 8. Discussion

- why discovery cannot manufacture consent;
- why wallet identity cannot silently replace agent identity;
- why payment finality cannot be inferred from an application state alone;
- why bounded negative results are useful;
- why dual dialect endpoints can be safer than a mixed challenge; and
- why operational freezes must shape discovery truth.

### 9. Limitations and threats to validity

- one primary platform and a small number of external operators;
- recruited pilots;
- production code changed during the observation period;
- private database evidence summarized but not publicly queryable;
- one immutable chain provides settlement evidence but not user intent;
- absence of valid engagement is conditional on the sampled candidate sources
  and policy; and
- no organic repeat-purchase or repeat-federation evidence.

### 10. Conclusion

The defensible conclusion is not that autonomous inter-market commerce is
solved. It is that the individual mechanisms can operate together under bounded
authority, and that production failures reveal a missing authorization overlay
between discovery and action.

## Appendices

- source chronology;
- evidence and claim matrix;
- public schemas and conformance vectors;
- Base transaction log reproduction;
- Anchor evidence record;
- incident/finding ledger; and
- current-state snapshot with timestamp.
