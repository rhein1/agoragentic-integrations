# Integration qualification and promotion loop

This package turns an external project review into a closed, inspectable qualification record without silently converting evidence into activation authority.

```text
external project
  -> relevance audit
  -> immutable release pin
  -> evidence-bound classification
  -> minimum truthful adapter
  -> conformance and adversarial tests
  -> public-safe evidence packet
  -> draft PR
  -> human promotion decision
  -> verified or blocked record
```

The package is private and source-consumed. It is not a published integration, deployment controller, provider client, wallet, or marketplace listing tool.

## Qualification levels

| Level | Evidence required for that claim |
|---|---|
| `research_only` | Canonical project identity from official metadata |
| `metadata_mapping` | A tested mapping into an Agoragentic artifact |
| `source_adapter` | A tested adapter implementation |
| `policy_enforcement` | A real host boundary observed enforcing or asking before action |
| `runtime_compatibility` | Exact release bytes verified, the exact host artifact loaded, and a host-runtime matrix passed |
| `exact_runtime_verification` | The exact runtime and destructive lifecycle cases observed inside the approved restricted environment |
| `hosted_availability` | The exact hosted endpoint observed currently available |
| `production_activation` | Production activation observed and separately approved by the owner |

Levels are evidence classifications, not implied feature bundles. `research_only` -> `metadata_mapping` -> `source_adapter` is the shared prerequisite path. `policy_enforcement` and `runtime_compatibility` are sibling branches from `source_adapter`; policy evidence is not inferred from runtime evidence or vice versa. The stronger runtime chain is `runtime_compatibility` -> `exact_runtime_verification` -> `hosted_availability` -> `production_activation`. Every level result, including inherited unmet prerequisites, stays visible in the packet.

## Promotion semantics

`evaluateQualification()` keeps three concepts separate:

- `declared_level` is the human-owned status already on record.
- `evidence_levels` contains every maximal classification supported by current evidence in the partial-order graph. `evidence_level` is populated only when that maximum is unique.
- `effective_level` fails closed when evidence regresses, but never rises automatically.

`promotion_candidate_levels` retains every maximal, not-yet-declared branch that is currently eligible for human review. The singular `promotion_candidate_level` is populated only when that candidate is unique; sibling policy/runtime results are never resolved by enum order. Callers must identify unresolved failed or unknown observations in `promotion_blockers`. A blocker preserves truthful `evidence_level` and `effective_level`, but empties the candidate fields and sets `promotion_blocked: true`; it is not misreported as an action-boundary violation or as lost compatibility evidence. `human_promotion_required` remains true when higher evidence exists, because a human decision is still required after the blockers are resolved. The evaluator always returns `auto_promoted: false`.

Static source, documentation, fixtures, generated examples, and model assertions cannot satisfy runtime, hosted, production, or human-decision predicates. Each claim requires the exact proof class encoded in `src/index.mjs`.

## Evidence packets

`createQualificationEvidencePacket()` requires caller-supplied real RFC 3339 timestamps, credential-free HTTPS subject and asset URLs, positive safe-integer byte counts, and nonblank evidence references. Before any caller-controlled field is read, it snapshots a bounded plain-JSON graph and rejects proxies, accessors, symbols, non-enumerables, custom prototypes, holes, cycles, credential-like text, and absolute/private paths. It then rejects undeclared or malformed schema fields, recomputes the classification, records every hard-stop boundary, and adds a canonical SHA-256 hash. A new hash cannot cure malformed or unsafe evidence. `verifyQualificationEvidencePacket()` applies the same passive public-safety gate before validating shape, hash, and semantics.

The generic verifier validates packet structure, public safety, self-hash integrity, and classification consistency. It does not dereference or independently authenticate caller-supplied evidence references. Each integration-specific consumer must cross-bind the exact expected references and digests to its reviewed artifacts before treating the packet as evidence.

The JSON Schema is [`schema/evidence-packet.v1.schema.json`](schema/evidence-packet.v1.schema.json).
It is a bounded structural interchange schema. Consumers must call `verifyQualificationEvidencePacket()` for authoritative calendar-date, public-safety, canonical-hash, and classification verification; schema-only acceptance is never sufficient evidence.

The release observer is report-only. A newer stable release produces `update_available`; it does not mutate the pin, download or execute the newer binary, change qualification, or create a public compatibility claim.

## Hard stops

This loop does not authorize credentials, paid provider calls, production deployment, package publication, outreach, public compatibility claims, wallet or settlement changes, trust changes, or ranking changes. Any such recorded activity blocks promotion and requires a separately scoped owner decision.

Run the contract tests with:

```bash
npm test --prefix integration-qualification
```
