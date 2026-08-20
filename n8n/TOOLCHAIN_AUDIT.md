# n8n Toolchain Audit

Audit date: 2026-08-20 (supersedes 2026-08-08)

## Candidate

- Package: `n8n-nodes-agoragentic@0.1.3`
- Stable builder: `@n8n/node-cli@0.44.4`
- Formatter: `prettier@3.9.6`
- Linter: `eslint@9.32.0`
- Compiler: `typescript@5.9.2`
- Development host fixture: `n8n-workflow@2.35.3`
- Exact workflow peer fixture: `zod@3.25.76`
- Release helper: `release-it@21.0.2`
- Minimum consumer Node.js: 20.19
- Install mode: committed lockfile plus `npm ci`

## Coordinated compatibility decision

The `@n8n/node-cli` npm `stable` tag is `0.44.4`. Its peer range accepts ESLint
9 or newer, but the CLI's current community-node lint plugin still calls the
removed ESLint 9 rule-context API. ESLint 10 therefore fails the required lint
gate with `TypeError: context.getFilename is not a function`. This candidate
advances the stable CLI while preserving the tested ESLint 9.32.0, Prettier
3.9.6, and TypeScript 5.9.2 lines.

The `release-it@21.0.2` maintenance update remains development-only. It changes
neither the published package contents nor the trusted-publishing path, and the
full clean-install test, lint, build, audit, and package gates remain required.

The rejected Dependabot majors are not a coherent toolchain:

- ESLint 10 fails the current n8n lint rules with
  `TypeError: context.getFilename is not a function`. The bundled community
  plugin also declares an exact ESLint 9.29.0 peer.
- TypeScript 7 fails the current parser stack in `ts-api-utils` while reading
  `Intrinsic`. The current `typescript-eslint` release supports TypeScript
  versions below 6.1, not TypeScript 7.

The release-contract test pins the complete supported set so a future isolated
major bump cannot look valid after changing only one manifest line.

`n8n-workflow@2.35.3` is the npm `stable` development fixture, not a runtime
constraint. Its exact peer is satisfied by `zod@3.25.76`. The published peer
remains `n8n-workflow: "*"`, so host n8n versions are not narrowed. These
fixtures keep clean-install build tests deterministic and are not shipped in
the package tarball.

## Security boundary

The published package audit is clean:

```text
npm audit --omit=dev --audit-level=moderate
found 0 vulnerabilities
```

The development-only n8n graph currently reaches `@n8n/utils@1.43.1` and its
`nanoid@3.3.8` pin. No compatible stable n8n release contains a patched
upstream pin, npm proposes an invalid downgrade to node-cli 0.20.0, and the n8n
community-node lint policy forbids an `overrides` field. The fail-closed
`npm run audit:dev` gate therefore permits exactly these two advisories and the
eight affected dependency nodes they currently reach:

- `GHSA-28wg-ghj8-5hjv`
- `GHSA-2v37-7h3g-55p8`

While high findings remain, a new or missing advisory ID, a severity
escalation, or an affected-package addition/substitution fails the gate. A
remediation-driven shrinking subset is intentionally accepted, including an
ancestor dropping below high severity, so an upstream partial fix does not
require weakening or rewriting the allowlist.
Moderate LangChain/uuid findings remain visible. In particular, open
Dependabot alert #8 (`GHSA-w5hq-g745-h8pq`) remains in the CLI's nested
LangChain graph: `@langchain/classic@1.0.27` and
`@langchain/community@1.1.27` resolve `uuid@10.0.0`, while the patched floor is
11.1.1. The explicit workflow fixture and top-level LangChain package resolve
`uuid@11.1.1`; removing the nested finding requires an upstream n8n CLI/AI SDK
release and must not be forced with the lint-forbidden `overrides` field. None
of these development dependencies are included in the package `files`
allowlist or npm tarball. Remove the nanoid exception as soon as stable n8n
packages consume a patched release.

The prior `brace-expansion`, `ip-address`, and `undici` high findings remain
resolved in the lockfile. `release-it@21` remains development-only and requires
Node 22.21 or newer for maintainers running the release helper; trusted npm
publishing does not use that helper.

## Validation

- `npm ci`
- npm 10 Linux/x64 clean-install dry-run with optional dependencies included
- `npm test`
- `npm run lint`
- `npm run build`
- exact root dependency and peer-tree inspection
- `npm audit --omit=dev --audit-level=moderate`
- `npm run audit:dev`
- `npm pack --dry-run`

Pull-request validation and trusted publishing repeat the lint, build, audit,
and package checks.
