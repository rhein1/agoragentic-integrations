# n8n Toolchain Audit

Audit date: 2026-09-01 (supersedes 2026-08-20)

## Candidate

- Package: `n8n-nodes-agoragentic@0.1.4`
- Builder: repository-local `scripts/build.mjs`
- Community lint plugin: `@n8n/eslint-plugin-community-nodes@0.29.0`
- Linter: `eslint@9.29.0`
- Formatter: `prettier@3.9.6`
- Compiler: `typescript@5.9.2`
- Development host fixture: `n8n-workflow@2.36.4`
- Exact workflow peer fixture: `zod@3.25.76`
- Minimum consumer Node.js: 20.19
- Locked development and publishing Node.js: 24
- Install mode: committed lockfile plus `npm ci`

npm currently serves `n8n-nodes-agoragentic@0.1.3` from the existing
`n8n-v0.1.3` release. This audited source candidate is 0.1.4 and must be
reviewed and merged before the exact `n8n-v0.1.4` tag can invoke the trusted
publishing workflow.

## Coordinated compatibility decision

Every available `@n8n/node-cli` line checked from 0.40.0 through the current
stable and beta releases pulls an AI/template-only dependency branch through
`@n8n/ai-node-sdk`. That branch pins `@langchain/classic@1.0.27` and
`@langchain/community@1.1.27`, which resolve vulnerable `uuid@10.0.0`. The n8n
community-node rules correctly reject package-manager `overrides`, so the
candidate removes the all-in-one CLI instead of bypassing that policy.

The replacement keeps the CLI 0.44.4 validation behavior used by this package:

- `eslint.config.mjs` reproduces the official cloud-support configuration with
  `@eslint/js`, TypeScript ESLint, the community-node plugin, import resolution,
  `eslint-plugin-n8n-nodes-base`, package metadata rules, and the same targeted
  credential/node rule exceptions;
- `scripts/build.mjs` removes `dist`, invokes the pinned local TypeScript
  compiler, and copies PNG, SVG, and `__schema__` JSON assets; and
- the direct lint dependencies are pinned to the versions already exercised in
  the prior CLI-backed lockfile.

The unused interactive `dev` and local `release` helpers were removed with the
CLI. Trusted publishing is unchanged: `.github/workflows/publish-n8n.yml` still
runs the fail-closed check and audit gates before publishing with provenance.

This is an explicit support boundary. n8n's public documentation is
inconsistent about whether verified-node authors must or should retain
`n8n-node`; the open-source scanner applies the package rules independently and
does not require that dependency by name. The direct toolchain passes the same
source lint and produces the same code/static assets locally, but closed Creator
Portal acceptance has not been exercised. Do not claim n8n Cloud verification
eligibility until a provenance-published artifact passes the real scanner and
Portal review.

The rejected dependency majors remain incoherent with this source candidate:

- ESLint 10 fails the pinned n8n community lint rules; the community plugin
  declares an exact ESLint 9.29.0 peer.
- TypeScript 7 is outside the supported range of the pinned TypeScript ESLint
  stack.

The release-contract test pins the complete supported set so a future isolated
major bump cannot look valid after changing only one manifest line.

`n8n-workflow@2.36.4` is the npm `stable` development fixture, not a runtime
constraint. Its exact peer is satisfied by `zod@3.25.76`. The published peer
remains `n8n-workflow: "*"`, so host n8n versions are not narrowed. These
fixtures keep clean-install build tests deterministic and are not shipped in
the package tarball.

The stable workflow fixture's development graph includes `isolated-vm@7`,
whose declared engine is Node.js 24 or newer. The published community node does
not ship that fixture, so the consumer floor remains Node.js 20.19; repository
validation and trusted publishing use Node.js 24 to satisfy the complete locked
development graph without ignoring engine metadata.

## Security boundary

Both published-package and complete development audits are clean:

```text
npm audit --omit=dev --audit-level=moderate
found 0 vulnerabilities

npm audit --audit-level=low
found 0 vulnerabilities
```

The CLI/AI/LangChain branch and `uuid@10.0.0` are absent from the lockfile. The
only resolved `uuid` is patched `uuid@11.1.1` beneath the stable workflow
fixture. Updating that fixture from 2.35.3 to 2.36.4 also moves
`@n8n/utils` to 1.44.0 and `nanoid` to patched 3.3.18, removing the two prior
high-severity nanoid exceptions. `npm run audit:dev` now rejects any advisory at
any severity; there is no development allowlist.

The prior `brace-expansion`, `ip-address`, and `undici` findings remain resolved
in this lockfile. None of the development dependencies are included in the
package `files` allowlist or npm tarball.

## Validation

- `npm ci`
- npm 10 Linux/x64 lock generation with optional dependencies included
- `npm test`
- `npm run lint`
- `npm run build`
- exact dependency and peer-tree inspection
- `npm audit --omit=dev --audit-level=moderate`
- `npm run audit:dev`
- `npm pack --dry-run`
- generated code/static-asset comparison against the prior CLI build

Pull-request validation and trusted publishing repeat the lint, build, audit,
and package checks.

## External references

- [n8n development requirements](https://docs.n8n.io/connect/create-nodes/build-your-node/set-up-your-development-environment)
- [n8n verification guidelines](https://docs.n8n.io/connect/create-nodes/build-your-node/reference/verification-guidelines)
- [n8n automated package scanner](https://github.com/n8n-io/n8n/blob/master/packages/@n8n/scan-community-package/scanner/scanner.mjs)
- [n8n community rule prohibiting overrides](https://github.com/n8n-io/n8n/blob/master/packages/@n8n/eslint-plugin-community-nodes/src/rules/no-overrides-field.ts)
