# n8n Toolchain Audit

Audit date: 2026-07-22

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
- `npm audit --audit-level=high`: zero high or critical vulnerabilities

Both audit commands run in pull-request validation and again in the trusted-publishing workflow, so the recorded boundary is release-gated rather than advisory-only.

## Residual Advisory

The stable n8n node CLI currently brings six moderate development-only findings through its AI SDK, LangChain, and `uuid` dependency chain. npm offers only an invalid downgrade of the builder as an automated fix. The package does not ship those development dependencies, and the production dependency audit is clean. This candidate does not force an incompatible transitive override or move to the 0.41 beta toolchain.

Recheck the advisory chain when n8n promotes a stable CLI release with an updated AI SDK dependency tree.
