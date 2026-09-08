# Commerce integration qualification

Verified locally on September 8, 2026 with Python 3.14.2 and Node 24.13.0.
This is a source integration with reproducible dependency-backed checks, not a
live merchant connector or a qualified complete Commerce runtime. The catalog remains experimental.

| Boundary | Evidence | Scope |
| --- | --- | --- |
| Preflight and synthetic SQLite store | 31 Python and 14 JavaScript regression tests | Approval expiry/revocation/binding, retries, persistence, atomic local evidence, receipt projection |
| Anthropic shared executor | `upstream_conformance.py`, eight cases | Real pinned executor, provenance, two approval gates, visible approved edit, expiry/revocation/changed request, apply-time guardrails |
| Python SDK 0.2.139 | `sdk_conformance.py` | Real HookMatcher/options, registration conversion, callback dispatch and serialized denial; synthetic CLI transport peer |
| TypeScript SDK 0.3.263 | `sdk-contract.ts`, `sdk-wire.test.mjs` | Strict SDK type compatibility and public query control-wire dispatch; synthetic in-memory CLI peer |
| Real CLI 2.1.263 + TypeScript SDK 0.3.263 | `cli-enforcement.test.mjs`, two cases | Real native CLI and Write tool; loopback Messages fixture; control = one file effect/one PostToolUse, adapter deny = zero effects/zero PostToolUse |
| Harness Core 0.4.2 | `dependencies.test.mjs` | Real canonical APIs, exported proof/receipt schemas, zero spend and explicit local evidence scope |
| Clean consumer installation | `framework-adapter-contracts.test.mjs` | Catalog copy instruction installs the Python adapter into an empty project and the imported adapter fails paid execution closed |
| Optimized Python qualification | `qualification-safety.test.mjs` | Qualification and fixture-evidence drivers contain no removable assertions; deliberately failed checks remain fatal under normal Python and `python -O` |

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
npm --prefix claude-agent-sdk run test:cli
python claude-agent-sdk/adapter.test.py
node --test test/framework-adapter-contracts.test.mjs
```

The existing `adapter-conformance` CI job runs these dependency-backed checks
without silent skips. Read hosted CI on the exact PR head separately from this
local record. Network access is required for dependency installation; the fixture
and SDK wire tests use no remote provider or model. The synthetic CLI peers are
explicit test doubles, not evidence that a real CLI obeyed a deny.

## Real CLI enforcement scope

The separate CLI lane uses the documented [gateway configuration](https://code.claude.com/docs/en/llm-gateway)
seam (`ANTHROPIC_BASE_URL`) with a deterministic local Messages fixture. The CLI
and SDK are unmodified. The test verifies the platform binary checksum against
the installed SDK manifest before spawning it. Fresh temporary home/config/cwd,
an allowlisted process environment, a non-provider fixture key, restricted tools,
no user/project settings, and no MCP configuration keep the run local. The fixture
does not forward requests; proxy CONNECT and unexpected routes fail the test.
This is not OS-level network or filesystem containment.

The same predetermined `Write` request is sent in both runs. The control host
permits only the exact synthetic path/content. The adapter-installed run records
`Unsupported_Tool` from its actual registered callback, an error tool result,
zero successful PostToolUse events, and no file. The control records one successful
PostToolUse and the exact file content. A missing hook, missing CLI round trip, or
missing positive effect fails rather than being interpreted as a successful deny.

This closes the bounded real-CLI unsupported-tool-denial gate for the TypeScript
adapter. It does not qualify Python's bundled CLI, a real model/provider, commerce
tool approval through MCP, an authenticated UI, or a live merchant. The shared
executor/SQLite proof remains separate from the CLI Write proof. Upstream
`qualified_runtimes` stays empty because no complete Commerce Agents runtime has
been qualified. Keep the PR draft for independent review and scope acceptance.
Local Harness receipts remain self-reported fixture evidence, not settlement proof.

No custody activation, payment enablement, deployment, registry publication,
listing publication, live merchant connection, or private ECF export is included.
