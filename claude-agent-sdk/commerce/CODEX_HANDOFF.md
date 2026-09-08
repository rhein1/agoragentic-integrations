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

## Real CLI enforcement and remaining review gate

The TypeScript adapter now has a provider-free actual-CLI enforcement test.
The pinned native CLI 2.1.263 consumes deterministic loopback Messages responses.
Its real Write tool produces one exact temporary file and one PostToolUse event
in the control; the adapter's registered Unsupported_Tool denial produces zero
files, zero successful PostToolUse events, and an error tool result.
The test verifies the native binary checksum and uses fresh temporary settings,
an allowlisted environment, and a synthetic key. CI runs it with `npm run test:cli`.

A follow-up reviewer should:

1. Refresh exact-head CI and reviews; fix reproducible failures without loosening
   approval, provenance, backend, or money boundaries.
2. Independently review the actual-CLI fixture, positive control, hook registration,
   and effect assertions against the bounded claim in QUALIFICATION.md.
3. Keep shared-executor, SDK-wire, local real-CLI, and production evidence separate.
   This test covers TypeScript unsupported-tool denial; Python CLI and commerce
   tool approval through MCP remain unqualified. Keep qualified_runtimes empty.
4. Keep this PR draft until independent review and scope acceptance. Any future
   paid/model canary requires separate owner authorization; do not read credentials
   or activate provider calls as part of this PR.

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
