# n8n Toolchain Audit

Audit date: 2026-08-08 (supersedes 2026-08-05)

## Candidate

- Package: `n8n-nodes-agoragentic@0.1.3`
- Stable builder: `@n8n/node-cli@0.42.2`
- Formatter: `prettier@3.9.6`
- Linter: `eslint@9.32.0`
- Compiler: `typescript@5.9.2`
- Development host fixture: `n8n-workflow@2.29.3`
- Release helper: `release-it@21.0.1`
- Minimum consumer Node.js: 20.19
- Install mode: committed lockfile plus `npm ci`

## Coordinated compatibility decision

The `@n8n/node-cli` npm `stable` tag is `0.42.2`. Its generated community-node
template still pins ESLint 9.32.0, Prettier 3.6.2, and TypeScript 5.9.2. This
candidate advances the stable CLI and independently validates the compatible
Prettier 3.9.6 maintenance update while preserving n8n's linter and compiler
major lines.

The rejected Dependabot majors are not a coherent toolchain:

- ESLint 10 fails the current n8n lint rules with
  `TypeError: context.getFilename is not a function`. The bundled community
  plugin also declares an exact ESLint 9.29.0 peer.
- TypeScript 7 fails the current parser stack in `ts-api-utils` while reading
  `Intrinsic`. The current `typescript-eslint` release supports TypeScript
  versions below 6.1, not TypeScript 7.

The release-contract test pins the complete supported set so a future isolated
major bump cannot look valid after changing only one manifest line.

`n8n-workflow@2.29.3` is an explicit development fixture, not a runtime
constraint. The published peer remains `n8n-workflow: "*"`, so host n8n
versions are not narrowed. The fixture keeps clean-install build tests
deterministic and avoids treating a vulnerable auto-installed peer as shipped
package code.

## Security boundary

The published package audit is clean:

```text
npm audit --omit=dev --audit-level=moderate
found 0 vulnerabilities
```

The stable n8n CLI's development-only AI SDK graph currently pins
`@n8n/utils` to `nanoid@3.3.8`. No stable n8n CLI release contains a patched
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
Moderate LangChain/uuid findings remain visible. In particular, Dependabot
alert #8 (`GHSA-w5hq-g745-h8pq`) remains in the CLI's nested LangChain graph:
the stable CLI pins LangChain releases that require `uuid@^10.0.0`, so the
patched `uuid@11.1.1` cannot satisfy that range. The explicit host fixture does
resolve `uuid@11.1.1`; removing the nested finding requires an upstream n8n
CLI/AI SDK release and must not be forced with the lint-forbidden `overrides`
field. None of these development dependencies are included in the package
`files` allowlist or npm tarball. Remove the nanoid exception as soon as stable
n8n packages consume a patched release.

The prior `brace-expansion`, `ip-address`, and `undici` high findings remain
resolved in the lockfile. `release-it@21` remains development-only and requires
Node 22.21 or newer for maintainers running the release helper; trusted npm
publishing does not use that helper.

## Validation

- `npm ci`
- `npm test`
- `npm run lint`
- `npm run build`
- formatter output comparison between Prettier 3.6.2 and 3.9.6
- `npm audit --omit=dev --audit-level=moderate`
- `npm run audit:dev`
- `npm pack --dry-run`

Pull-request validation and trusted publishing repeat the lint, build, audit,
and package checks.
