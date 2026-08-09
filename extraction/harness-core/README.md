# Harness Core standalone extraction

This directory prepares issue #238 without exercising repository or release authority.

The preparation script uses `git subtree split` against an exact source commit, places the
Harness Core package at the extracted repository root, copies the bounded framework examples,
adds standalone governance and workflow files, and rewrites package metadata for the proposed
`rhein1/agoragentic-harness-core` repository. The output has no Git remote and remains dirty for
owner review and a separately signed commit.

It does not:

- create a GitHub repository;
- add or push a remote;
- publish an npm package or release;
- change npm ownership or trusted-publisher settings;
- remove `harness-core/` from the integrations repository;
- grant wallet, spend, provider, deployment, publication, or trust authority.

## Local preparation

Use an exact, reviewed source commit and a nonexistent output directory outside this repository:

```bash
node scripts/prepare-harness-core-extraction.mjs \
  --source . \
  --source-ref <reviewed-commit> \
  --output ../agoragentic-harness-core-prepared

node scripts/verify-harness-core-extraction.mjs \
  --repo ../agoragentic-harness-core-prepared
```

The verifier checks filtered history, root package metadata, flagship copy, examples, no-spend CI,
release-only trusted publishing, the all-false preparation authority record, package tests, example
validation, pack smoke, and an npm dry run.

## Owner-gated cutover

Proceed in this order. Stop on any mismatch.

1. Review `EXTRACTION_PROVENANCE.json`, the complete diff, and the retained Git history.
2. Explicitly authorize creation of the public `rhein1/agoragentic-harness-core` repository.
3. Create the empty repository without a generated README, license, or `.gitignore`.
4. Add that repository as `origin` in the prepared checkout.
5. Create a signed commit containing only the reviewed standalone overlay and metadata changes.
6. Push `main`, enable required reviews and CI, add the repository description/topics/social preview,
   and verify the standalone CI on GitHub.
7. Configure npm trusted publishing for the standalone repository and
   `.github/workflows/publish.yml`; do not use a long-lived npm token.
8. Verify `npm pack --dry-run --json`, provenance configuration, and the exact `v<version>` release
   tag before publishing.
9. Publish only through the reviewed release workflow. Confirm npm source, homepage, and issue links
   point to the standalone repository.
10. Open a separate integrations PR that replaces `harness-core/` with a thin pointer, updates
    `ecosystem.json`, `integrations.json`, docs, profile links, and downstream repositories, and records
    the compatibility path. Merge that PR only after the standalone package and release are proven.

Issue #238 remains open until the standalone repository, CI, npm metadata, release authority,
cross-repository links, and removal of the duplicate canonical implementation are all verified.

## Rollback

Before npm publication, rollback is deletion of the unadvertised target repository and local prepared
checkout; the integrations repository remains canonical. After publication, do not delete or reuse the
package version. Publish a reviewed corrective release and preserve migration links.
