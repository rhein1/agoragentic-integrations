# Codex handoff: finish the bounded Commerce Agents integration

## Owner and outcome

One Codex engineering owner should finish, verify, and report this PR end to end.
Keep work in `rhein1/agoragentic-integrations` on the PR branch. Start with current
`AGENTS.md`, `integrations.json`, the framework README, and current PR/review state.
Do not overwrite parallel Risk Fork work or create a new product/repository.

The observable outcome is one developer running a no-money merchant flow through
Anthropic's actual pinned shared executor: a title edit stays staged without
approval, the exact approved fixture edit becomes visible, revoked/expired/changed
requests stay blocked, and the resulting local evidence does not claim settlement
or production protection.

## Already implemented in this PR

- Python/TypeScript legacy adapter hardening: no pending-approval allow, no default
  allow for unknown tools, bounded decimal caps, strict Python configuration,
  explicit SDK callback/factory, no environment-triggered paid activation.
- Lossy receipt projection with no raw identifiers, hashes, addresses, signatures,
  nested fields, or input mutation; explicitly not a verifier or general PII filter.
- Synthetic SQLite backend state, exact change/session/merchant/operator binding,
  host-only test approval, expiry, revocation, apply-time policy revision, stale
  record rejection, idempotent apply, and atomic effect/evidence/consumption.
- Typed bridge/subclass for upstream MerchantBackend and MerchantToolExecutor,
  preserving upstream gates and denying all unsupported business operations.
- Pinned-source conformance driver with no mock fallback, plus the upstream pin file.
- Optional composition with the existing Harness Core APIs, not a copied engine.
- Local demo, 31 Python tests, 14 Node tests, and wiring into the existing
  `framework-adapter-contracts` suite in the `adapter-conformance` CI job.

Implementation-environment evidence: Python 3.13.5 and Node 22.16.0; the 45 local
regression tests passed, TypeScript strict no-emit checking passed, Python source
compilation passed, and the local demo recorded one synthetic effect. This is
local evidence, not a hosted CI or release claim. Subagents: none_available.

## Finish in this order

### 1. Confirm exact-head source and integration compatibility

Read the current branch diff and reconcile current `main` before editing. Preserve
intentional blocking changes. Check whether any consumer depended on the old
unsafe `allowed=True` or permissive unknown-tool behavior. Do not restore either.
Keep the single upstream pin holder; do not silently advance to upstream `main`.

### 2. Run the actual upstream driver and fix any integration mismatch

Acquire the upstream revision recorded in `upstream.json` as a local dependency,
install its packages in a dedicated environment, and run:

```bash
python claude-agent-sdk/commerce/upstream_conformance.py --checkout /path/to/pinned/commerce-agents
```

This driver was syntax-checked but not executed here because the implementation
container could not clone/download GitHub sources or install network dependencies.
Do not count a missing package, skipped test, copied implementation, or mocked
executor as a pass. Verify actual module origins, unchanged upstream provenance
and guardrails, both approval boundaries, a visible persisted title, and denial
of a revoked change despite a stale upstream approval mark. Capture exit status
and exact source/dependency versions. Add this dependency-backed gate to the
existing conformance workflow rather than introducing a new workflow family.

### 3. Qualify the real SDK hook and canonical Harness composition

Install an explicitly pinned supported Claude Agent SDK. Instantiate its actual
`HookMatcher`/options and test callback registration and host handling of a deny.
The local tests only verify callback shapes and a constructor stub. Extend both
Python and TypeScript host-contract tests without broadening authority. An API key
or paid model turn is not required for the initial host-contract test; request
explicit separate permission for a later provider-funded canary.

Run `harness-evidence.mjs` against the actual pinned Harness package. Validate its
receipt against Harness's exported canonical schema. Preserve the distinction
between local fixture evidence, hosted invocation evidence, and settlement proof.
Do not add a fallback signer/receipt schema or treat Harness review artifacts as
live execution tokens. The provided policy mapping is advisory, not in-path.

### 4. Close documentation and inventory truth

Keep the integration under the existing `claude-agent-sdk` entry; the nested
fixture is not a new top-level integration and must not inflate counts. Reconcile
the entry's existing beta label/compatibility text with actual evidence. Update
canonical skills only when the supported path is demonstrated; use the existing
skill-pack generator, never hand-edit generated client copies. Do not advertise
production commerce support, Managed Agents parity, a payment rail, or Anthropic
endorsement. Leave `qualified_runtimes` empty unless exact evidence supports a
specific bounded entry. A passing shared-executor test is not a full runtime test.

Run affected checks and the existing repository validation:

```bash
python claude-agent-sdk/adapter.test.py
node --experimental-strip-types --test claude-agent-sdk/adapter.test.mjs
python -m compileall -q claude-agent-sdk
node --test test/framework-adapter-contracts.test.mjs
node scripts/generate-integration-capability-status.mjs --check
node scripts/sync-integration-counts.mjs --check
node scripts/generate-repository-rename-preflight.mjs --check
node scripts/generate-skill-pack.mjs --check
node scripts/verify-doc-links.mjs
git diff --check
```

Run `framework-adapter-contracts` under Node 24 as the existing CI does. If an
unrelated pre-existing check fails, report the exact failure instead of suppressing
it or claiming the whole repository passes. Re-run current hosted checks after
the final commit; review any signing/branch requirements without bypassing them.

## Non-negotiable exclusions

No custody unfreeze, funding, signing, paid execution/retry/settlement, checkout,
marketplace publication, trust mutation, hosted deployment, remote MCP relay,
private ECF exposure, Risk Fork activation, new brand, or new policy engine.
Payment architecture remains retained, not retired. Any later live merchant
connector is separate reviewed work; do not repoint the fixture at a production URL.

## Completion report

State the exact final commit, changed files, commands/results, CI status, and source
pins. Separate exercised paths (local preflight, SQL state, shared executor when
actually run, dependency-backed Harness when actually run) from unverified paths
(browser UI, host authentication, SDK model loop, MCP, workers, external merchant,
payments). Do not mark this PR ready solely because the hermetic suite is green.
