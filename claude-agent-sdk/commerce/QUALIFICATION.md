# Commerce integration qualification

Verified locally on September 8, 2026 with Python 3.14.2 and Node 24.13.0.
This is a source integration with reproducible dependency-backed checks, not a
live merchant connector or a qualified Claude host. The catalog remains experimental.

| Boundary | Evidence | Scope |
| --- | --- | --- |
| Preflight and synthetic SQLite store | 31 Python and 14 JavaScript regression tests | Approval expiry/revocation/binding, retries, persistence, atomic local evidence, receipt projection |
| Anthropic shared executor | `upstream_conformance.py`, eight cases | Real pinned executor, provenance, two approval gates, visible approved edit, expiry/revocation/changed request, apply-time guardrails |
| Python SDK 0.2.139 | `sdk_conformance.py` | Real HookMatcher/options, registration conversion, callback dispatch and serialized denial; synthetic CLI transport peer |
| TypeScript SDK 0.3.263 | `sdk-contract.ts`, `sdk-wire.test.mjs` | Strict SDK type compatibility and public query control-wire dispatch; synthetic in-memory CLI peer |
| Harness Core 0.4.2 | `dependencies.test.mjs` | Real canonical APIs, exported proof/receipt schemas, zero spend and explicit local evidence scope |

The upstream commit remains `fd4d59224ab96b43c6dc6888207c67b3bd5a24cf`, recorded
once for machine consumption in `upstream.json`. The driver verifies a clean
checkout, five reviewed boundary-file Git blobs, and actual Python import origins.
Python dependencies follow the upstream requirements pins (including anthropic
0.122.0 and pydantic 2.13.4). Windows-only transitive packages and build tooling
are resolved during setup; this is not a fully hash-locked Python supply chain.
The npm dependency closure is committed in `../package-lock.json`.

The older TypeScript SDK 0.2.141 had unresolved names in its published declarations.
The tested 0.3.263 pin passes strict checking without `skipLibCheck`, local declaration
patches, or copied SDK types. Its installed npm closure reports zero vulnerabilities
at verification time. Python and TypeScript package versions are independently scoped.

## Reproduce

From a complete checkout of this integration repository, choose two separate
development directories outside the repository. The first command explicitly
downloads source/dependencies and creates the virtual environment; it then runs
the upstream and Python SDK checks. It never starts Claude or uses an API key.

```bash
python claude-agent-sdk/commerce/qualify.py --checkout /path/to/commerce-upstream --venv /path/to/commerce-venv
npm --prefix claude-agent-sdk ci --ignore-scripts
npm --prefix claude-agent-sdk run typecheck
npm --prefix claude-agent-sdk test
python claude-agent-sdk/adapter.test.py
node --test test/framework-adapter-contracts.test.mjs
```

The existing `adapter-conformance` CI job runs these dependency-backed checks
without silent skips. Read hosted CI on the exact PR head separately from this
local record. Network access is required for dependency installation; the fixture
and SDK wire tests use no remote provider or model. The synthetic CLI peers are
explicit test doubles, not evidence that a real CLI obeyed a deny.

## Remaining release gates

Actual Claude Code deny enforcement remains unqualified. Neither SDK control-wire
test runs a real CLI, model loop, authenticated host approval surface, Managed
Agents deployment, worker, MCP transport, or merchant backend. `qualified_runtimes`
therefore stays empty. Keep PR #370 draft until its owner/reviewer resolves that
gate against the requested scope. Local Harness receipts are self-reported
fixture evidence, not payment or settlement evidence.

No custody activation, payment enablement, deployment, registry publication,
listing publication, live merchant connection, or private ECF export is included.
