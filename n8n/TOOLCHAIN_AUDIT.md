# n8n Toolchain Audit

Audit date: 2026-07-24

## Candidate

- Package: `n8n-nodes-agoragentic@0.1.3`
- Stable builder: `@n8n/node-cli@0.40.3`
- Release helper: `release-it@20.2.1`
- Minimum Node.js: 20.19
- Install mode: committed lockfile plus `npm ci`

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
