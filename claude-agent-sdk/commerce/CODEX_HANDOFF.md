# Codex handoff: Commerce Agents PR #370

Continue this PR on its existing branch. Do not scaffold another integration.
Read repository AGENTS.md, the current PR diff/reviews, and
[QUALIFICATION.md](QUALIFICATION.md) before changing scope or readiness.

## Completed source and qualification work

The initial preflight hardening and synthetic SQLite store remain intact.
The September 8 continuation reconciles main, adds repeatable dependency setup,
and exercises Anthropic's actual pinned shared executor. Eight cases cover
provenance, upstream approval, backend approval, the exact applied edit,
revocation, expiry, changed requests, and current upstream guardrails.

Python SDK 0.2.139 and TypeScript SDK 0.3.263 register the real adapter callbacks
and preserve their deny output through the installed SDK control protocol.
Their CLI peers are synthetic test doubles. TypeScript strict checking uses the
actual SDK declarations without skipLibCheck or local type shims.

Installed Harness Core 0.4.2 composes local fixture evidence and passes validation
against its exported proof and receipt schemas. The npm closure is locked. Python
uses upstream third-party pins; platform/build dependencies are not fully hash-locked.
The existing adapter-conformance job now runs all dependency-backed lanes.
The catalog records experimental local evidence without adding an integration.
Canonical integration-skill guidance is propagated through the existing generator.

## Remaining implementation and review gate

Real Claude Code deny enforcement is still unqualified. The SDK wire tests prove
callback registration, dispatch, and serialization; they do not prove a real CLI
prevented a tool effect. Keep qualified_runtimes empty and this PR draft until
that gate is resolved explicitly against the owner's intended scope.

A follow-up engineer should:

1. Refresh exact-head CI and reviews; fix reproducible failures without loosening
   the approval, provenance, backend, or money boundaries.
2. Determine whether the pinned SDK/CLI exposes a provider-free supported way to
   invoke an inert fixture tool through actual host enforcement. If it does,
   exercise denied and permitted controls and record observable effect counts.
   Never claim that another synthetic CLI peer closes this gate.
3. If real-host qualification requires a paid/model canary, prepare its exact
   bounded procedure and request separate owner authorization before running it.
   Do not read credentials or activate provider calls as part of this PR.
4. Preserve source/local, shared-executor, SDK-wire, real-host, and production
   evidence as separate states. Only expand compatibility claims when the matching
   path has actual evidence and independent review.

## Reproduce and validate

Run the commands in QUALIFICATION.md, followed by:

```bash
python -m compileall -q claude-agent-sdk
node scripts/generate-integration-capability-status.mjs --check
node scripts/sync-integration-counts.mjs --check
node scripts/generate-repository-rename-preflight.mjs --check
node scripts/generate-skill-pack.mjs --check
node scripts/verify-integrations-json.js
node scripts/verify-doc-links.mjs
git diff --check
```

Missing dependencies and skipped checks are not passes. Read hosted CI separately
on the final commit. Keep the upstream revision in upstream.json; never silently
advance it. Preserve parallel Risk Fork and other main-branch changes.

## Authority boundary

No custody unfreeze, funding, signing, paid execution/retry/settlement, checkout,
marketplace publication, trust mutation, deployment, remote MCP relay, private ECF
export, or Risk Fork activation. The fixture is not an authenticated approval UI,
worker, merchant connector, or payment rail. Payment architecture remains retained.
No merge, release, or registry publication is authorized by this handoff.
