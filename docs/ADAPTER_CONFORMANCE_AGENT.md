# Adapter Conformance Agent

The Adapter Conformance Agent is the repository-owned, deterministic QA lane for every entry in `integrations.json`. It replaces broad subjective review with repeatable evidence that can run on every pull request.

## Run it

Node.js 24 and Python 3 are required for the full JavaScript, TypeScript, Python, and JSON syntax matrix.

```bash
node scripts/adapter-conformance-agent.mjs
node scripts/adapter-conformance-agent.mjs --adapter langchain,crewai
node scripts/adapter-conformance-agent.mjs --jobs 4 --report ./adapter-conformance-report.json
```

The command exits non-zero when any deterministic check fails. `--report` writes a JSON artifact atomically even when an adapter fails, so CI preserves the evidence.

## Forked worker model

The coordinator reads `integrations.json` and forks one short-lived worker per integration, with bounded concurrency and a per-worker timeout. Each worker receives only the repository root and one manifest entry.

Workers inherit runtime path variables needed to find Node and Python. API keys, cloud credentials, wallet material, and other application environment variables are not inherited.

The worker does not import or execute adapter code. JavaScript is passed to `node --check`, TypeScript is stripped and parsed, Python is passed to `ast.parse`, and JSON is passed to `JSON.parse`.

## Checks

| Check | Failure meaning |
|---|---|
| Manifest fields | A required integration field is missing. |
| Repository containment | A primary or documentation path is missing, absolute, traverses outside the repo, or resolves through an escaping symlink. |
| Syntax | The primary JavaScript, TypeScript, Python, or JSON artifact cannot be parsed offline. Documentation-only entries are `not_applicable`. |
| Credential literals | A credential-shaped literal is present in the primary artifact or its documentation. Reports include only the rule and file path, never the matched value. |
| Execute-first signal | An advisory is emitted when neither the primary artifact nor docs expose the current execute-first path. |
| Colocated tests | An advisory is emitted when no adapter-local test file is present. This keeps syntax-only evidence from being mistaken for runtime coverage. |

## Evidence boundary

Every report states the limits directly:

- adapter code was not executed;
- no network call was made;
- no paid call or wallet action was made;
- production was not mutated;
- worker processes did not inherit credential values.

A passing result means the declared files, syntax, and static safety checks passed. It does not mean a framework dependency was installed, a live endpoint was reached, settlement occurred, or a receipt was verified.

## Adding runtime coverage

Add a focused hermetic test beside the adapter when behavior needs proof. Stub framework dependencies and HTTP responses, then assert tool shape, request mapping, error handling, payment ceilings, repeated-402 behavior, and receipt binding as applicable.

Do not add production calls, package installation, API keys, wallets, or funded canaries to the generic conformance worker. Any live or paid probe remains a separate, explicitly authorized lane.
