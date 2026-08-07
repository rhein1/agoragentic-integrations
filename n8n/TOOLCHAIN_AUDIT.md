# n8n Toolchain Audit

Audit date: 2026-08-05 (supersedes 2026-07-24)

## Candidate

- Package: `n8n-nodes-agoragentic@0.1.3`
- Stable builder: `@n8n/node-cli@0.40.3`
- Release helper: `release-it@21.0.1`
- Minimum Node.js: 20.19
- Install mode: committed lockfile plus `npm ci`

## 2026-08-05 revision

Three high advisories entered the development graph and the fail-closed
`npm run audit:dev` gate correctly rejected them
(`unexpected audit package set; extra=ip-address,undici`, then
`unexpected advisory set: ...,GHSA-rgw5-rvv9-x895`).

**`ip-address` → 10.4.0.** Lockfile refresh only, satisfies `socks`'
`^10.1.1`. No manifest change.

**`brace-expansion` → 1.1.18 / 2.1.4 / 5.0.9.** GHSA-rgw5-rvv9-x895 is a
bypass of the previously accepted GHSA-mh99-v99m-4gvg. The exception recorded
below is now **stale**: patched releases exist on the 1.x and 2.x lines, so
the eslint and n8n-cli consumers are fixed in place without being forced onto
the API-incompatible 5.x line. Both advisories are now resolved rather than
allowlisted.

**`undici` → 7.29.0.** Reached through `@n8n/backend-network` (`^7.28.0`,
satisfied directly) and through `release-it@20.2.1`, which pins `undici`
to exactly `7.28.0`. Two candidate fixes were rejected:

- A scoped `overrides` entry — **rejected by lint.** The
  `@n8n/community-nodes/no-overrides-field` rule forbids the `overrides` field
  in community node packages outright.
- Staying on `release-it@20.x` — **no patched release exists.** `20.2.1` is
  the final 20.x version.

`release-it` is therefore bumped to `21.0.1`. Note this changes the
deliberately locked release pin asserted in `test/release.test.cjs`, updated
in the same change.

`release-it@21` declares `engines.node ^22.21.0 || >=24.0.0`. This does **not**
change what the published package supports: `engines.node` stays `>=20.19.0`
for consumers, `release-it` is development-only and is not in the published
`files` list, and the n8n CI job already runs on Node 22 ("Setup Node 22 for
n8n toolchain"). Only a maintainer running `npm run release` locally now needs
Node 22.21 or newer. `release-it` is not used by CI or by
`publish-n8n.yml`, which publishes via npm trusted publishing.

The `uuid` / LangChain moderates described below are unchanged and remain
accepted under the existing policy. The gate covers high and critical only,
so those stay visible rather than suppressed.

## Validation

- `npm test`
- `npm run lint`
- `npm run build`
- `npm pack --dry-run`
- `npm audit --omit=dev --audit-level=moderate`: zero production vulnerabilities
- `npm run audit:dev`: only the documented development advisory is present

Both audit commands run in pull-request validation and again in the trusted-publishing workflow, so the recorded boundary is release-gated rather than advisory-only.

## Transitive Security Policy

The stable n8n node CLI currently brings moderate development-only findings
through its AI SDK, LangChain, and `uuid` dependency chain. npm offers only an
invalid downgrade of the builder as an automated fix. The package does not ship
those development dependencies, and the production dependency audit is clean.

The graph also contains GHSA-mh99-v99m-4gvg through older minimatch consumers.
The only patched `brace-expansion` release is the API-incompatible 5.0.8 line;
forcing it into those consumers breaks the n8n lint toolchain. This dependency
is development-only, receives no untrusted glob input in this package, and is
not included in the published tarball.

CI and trusted publishing run a fail-closed high/critical audit policy that
permits only GHSA-mh99-v99m-4gvg in the full development graph while rejecting
every other high or critical advisory. Moderate development-only findings
remain visible in npm and Dependabot rather than being hidden.

Recheck this exception when n8n promotes a stable CLI release with an updated
minimatch dependency tree.
