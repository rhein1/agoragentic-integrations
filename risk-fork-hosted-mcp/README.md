# Risk Fork Hosted MCP Runtime Bundle

This directory builds the private, unpublished `@agoragentic/risk-fork-hosted-mcp@0.1.0-alpha.0` artifact. It bundles the reviewed `agoragentic-mcp` 2.0.0 enforcement/relay source and the fail-closed library surfaces of `@agoragentic/risk-fork@0.1.0-alpha.0` into one integrity-bound ESM file. Upstream source inputs are pinned by a sorted exact-digest inventory in `integrity-manifest.json`; packaged operational assets are independently exact-hashed. Reviewed UTF-8 source bytes canonicalize CRLF pairs to LF while preserving lone CR bytes. Ordinary builds require no Git history or object database, reject mismatched source, and accept a changed digest only through the explicit `--refresh-reviewed-sources` review action.

The artifact supplies library code only. It does not supply a production host adapter, credentials, trust decisions, deployment authority, approval, or permission to route live traffic. Publication is deliberately disabled.

## Private host contract

The embedding host creates the only accepted enforcement capability:

```js
import {
  MCP_ENFORCEMENT_SCHEMAS,
  computeMcpCleanImportEvidenceHash,
  connectRemoteClient,
  createMcpEnforcementBoundary,
} from '@agoragentic/risk-fork-hosted-mcp';

const enforcementBoundary = createMcpEnforcementBoundary({
  async openSession(openRequest) {
    // Risk Fork preparation and host-owned connection happen here.
    // Return exactly { schema, discovery, request, close }.
  },
  async executeFallback(fallbackRequest) {
    // Required adapter shape only. Current source hard-blocks every fallback
    // before this callback and must never invoke it.
    throw new Error('fallback execution is not qualified');
  },
});

const session = await connectRemoteClient({
  remoteUrl: 'https://qualified.example/mcp',
  enforcementBoundary,
});
```

`openSession` receives `MCP_ENFORCEMENT_SCHEMAS.sessionOpenRequest` for `server/discover` before any host connection. Its result must use `MCP_ENFORCEMENT_SCHEMAS.hostSession`, provide a clean-imported discovery envelope, and expose `request(phaseRequest)` plus idempotent `close()` functions. Each remote-session phase result must use `MCP_ENFORCEMENT_SCHEMAS.cleanImportedResult`, preserve `authority_granted: false`, and bind the exact request and result using `computeMcpCleanImportEvidenceHash`. There is currently no fallback result contract in use: every fallback is rejected before request construction or callback invocation until a durable host effect fence with exact idempotency and terminal reconciliation is qualified.

The host owns all network transport, redirect policy, credentials, isolation, cleanup, evidence, and kill-switch behavior. There is no direct network fallback in this package.

## E2B and PostgreSQL host surfaces

The main export also includes the framework-neutral Risk Fork host-boundary/import constructors, cleanup verification request/evidence validators, reviewed E2B adapter, paths, qualification evidence/trust functions, exact SDK dependency-closure verifier/loader, authority-free source verifier, PostgreSQL authority class and production predicate, and PostgreSQL migration/schema-verification functions. These are library contracts only: they do not provide a production host, provider authority, or live activation. `e2b` is the only unbundled package surface: it is an optional, exact `e2b@2.39.0` peer. Qualified use must verify its installed dependency closure and load it with `loadVerifiedE2BRuntimeSdk`; merely installing that peer does not qualify E2B or grant execution authority.

The E2B build context preserves its reviewed repository-relative layout and is importable from:

```js
import {
  createRiskForkE2BTemplate,
} from '@agoragentic/risk-fork-hosted-mcp/e2b-context/risk-fork/e2b-template/template.mjs';
```

The package also exposes the reviewed assets below through package subpaths:

- `migrations/001_distributed_authority.pg.sql`
- `ops/postgres/owner-bootstrap.sql.template`
- `ops/postgres/roles.sql.template`
- `schema/e2b-qualification-evidence.v1.json`

These files are inputs for an owner-controlled staging procedure, not a migration authorization or managed-database readiness claim. The PostgreSQL production predicate is intentionally strict; managed TLS, role separation, backup/restore, failover, monitoring, and reconciliation drills still require independent environment evidence.

### E2B is not the outbound MCP transport

The E2B adapter cannot safely be substituted for the host-owned outbound MCP session. Its clean-template requests use deny-all network settings and boot probes, but no credentialed run proves first-instruction or IPv6 containment; it runs bounded workspace operations and does not implement an arbitrary remote MCP transport. Its live SDK/provider path is also hard-disabled in the reviewed source because the same-UID birth watcher is not a separately privileged attestation authority. Signed qualification evidence cannot enable that path. `connectRemoteClient` therefore still requires a separately qualified host enforcement boundary that owns the network session and clean import. This artifact alone does not close the hosted-MCP runtime qualification gate.

## Reproducible artifact checks

Run the build, test, source-lineage verification, and pack checks only from this repository's source checkout, where `src/`, `test/`, and `scripts/build.mjs` are present:

```text
npm run build
npm test
npm run verify:source
npm run pack:dry
```

From an installed or extracted packed artifact, run the packaged integrity verifier instead:

```text
npm run verify
# equivalent: node scripts/verify-integrity.mjs
```

`integrity-manifest.json` records the source-attestation normalization contract, sorted reviewed-source digest inventory, upstream versions, every bundled source input, build version, runtime exports, packaged assets, optional exact E2B peer, and final bundle digest. `THIRD_PARTY_NOTICES.txt` is generated from exact dependency source bytes: a standalone license file is preferred, discovered from the package's actual directory entries, and recorded with its exact on-disk casing. Ambiguous or non-file license entries fail closed. Only the reviewed `pg-types@2.2.0` and `pgpass@1.0.5` fallbacks may use their complete single README license sections. The source path, byte count, source hash, extraction method, extracted byte count, and extracted hash are recorded and verified; a missing, ambiguous, unsupported, or incomplete fallback fails the build. The packed artifact has no mandatory runtime package dependencies or cross-worktree imports. Publication remains blocked by `prepublishOnly`.
