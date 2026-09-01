# Agoragentic ARD v0.91 source profile

This directory is a source-only, default-off implementation of Agentic Resource Discovery (ARD) proposal v0.91. It is pinned to upstream commit `aa3e598bb7752a9175897823234311216acfa864`.

It provides:

- byte-pinned upstream ARD and predecessor schemas, JSON-LD context, license, and provenance;
- a stricter local Agoragentic profile and JSON-LD extension vocabulary;
- one canonical source model with deterministic `ard.json` and `ai-catalog.json` compatibility output;
- an offline, bounded, fail-closed normalizer;
- examples for Interchange, MCP, A2A, and Risk Fork;
- valid and adversarial fixtures plus hermetic tests.

It does not fetch or dereference remote contexts, expose a network listener, register a well-known route, execute an agent, spend or settle funds, verify or promote trust, publish a listing, deploy anything, or grant authority to do any of those things. Generated files are repository artifacts only. They are not evidence that `/.well-known/ard.json` or `/.well-known/ai-catalog.json` is deployed.

## Local checks

```bash
cd ard
npm ci --ignore-scripts
npm run check
npm run generate:check
npm test
```

The package has no runtime dependencies and no install or publish script. `npm run generate` writes only the bounded local files under `generated/` and `examples/`.

## Compatibility and hardening

ARD v0.91 makes `/.well-known/ard.json` canonical and permits a consumer to fall back to the predecessor `/.well-known/ai-catalog.json`. The upstream sources do not require the two resources to be byte-identical. This package deliberately generates identical intersection payloads with `specVersion: "1.0"` so the same file is acceptable to both the pinned predecessor shape and the v0.91 open manifest shape.

The vendored upstream files are unmodified. Local hardening lives in `schema/agoragentic-ard-profile.v0.91.schema.json` and `src/profile.mjs`:

- identifiers require a lower-case valid FQDN and at least namespace plus terminal-name segments;
- `@id` must equal `identifier`;
- exactly one of `url` or `data` is allowed;
- referenced artifacts require the literal `https://` URL form used by the local schema;
- the manifest root requires `specVersion: "1.0"`, rejects undeclared root fields, and preserves declared optional entry-field types;
- remote JSON-LD contexts are rejected unless pinned in the local allowlist;
- all 28 local extension terms canonicalize compact aliases and full-IRI equivalents to their `ag:` keys, while contradictory equivalents fail closed; the schema admits only those canonical key spellings;
- lower-case `trustManifest` is validated and publisher-bound, while the defective capitalized form is rejected;
- malformed, oversized, duplicate, and authority-bearing input fails closed;
- representative-query absence or counts outside 2–5 produce warnings, never eligibility or trust promotion;
- the local extension context uses the shared `https://agoragentic.com/ns/ard#` namespace;
- `trustState`, `riskLevel`, `executionAuthorizationRequired`, `riskForkAvailable`, `riskForkRequired`, `transactionAssuranceAvailable`, `paymentRails`, `priceModel`, `receiptVerifier`, `providerQualification`, and `liveExecutionAvailable` form a bounded descriptive contract;
- `executionAuthorizationRequired` is always true, while route, ranking, listing, payment, settlement, trust-promotion, execution, authentication-bypass, publication, and Risk Fork bypass authority derived from discovery are always false;
- execution, payment, trust-promotion, publication, network-dereference, and live-execution authority flags remain false.

Risk Fork availability, transaction-assurance availability, payment-rail names, price models, and receipt-verifier URLs are descriptive source metadata only. They do not prove that a provider, wallet, verifier, isolation boundary, or live execution path is qualified, deployed, enabled, or callable. Every canonical entry remains `unverified`, `unassessed`, source-only, default-off, and unavailable for live execution; the Risk Fork example is additionally labeled `source_only_not_live_qualified`.

See `provenance.json` for upstream hashes, license evidence, preserved draft defects, registry URL ambiguity, and media-type status. In particular, the pinned ARD text explicitly describes the A2A and MCP card media types as community formats with formal registration pending. The other two media types are labeled as provisional local profile tokens without extending that upstream claim.

## Licensing

The pinned ARD repository is Apache-2.0. Exact unmodified upstream copies are under `vendor/ard-v0.91/` with its full license. The upstream tree has no NOTICE file. The rest of this package follows the repository license unless a file states otherwise.
