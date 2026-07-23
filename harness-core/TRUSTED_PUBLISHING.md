# Harness Core Trusted Publishing

`agoragentic-harness-core` is package-ready but should not be published with a long-lived npm token.

## Publication Gate

Publish only after:

- The source scaffold has merged to `main`.
- `npm test` passes in `harness-core/`.
- `npm run pack:smoke` installs the tarball outside the repository and resolves every exported schema.
- `npm pack --dry-run` shows only intended files.
- The npm package is configured for Trusted Publishing with this repository and workflow.
- At least one external builder validates the local no-spend flow.

## Expected Trusted Publisher

- npm package: `agoragentic-harness-core`
- GitHub repository: `rhein1/agoragentic-integrations`
- Workflow: `.github/workflows/publish-harness-core.yml`
- Exact release tag: `harness-core-v<package.json version>`

## Publish Flow

1. Configure npm Trusted Publishing for the package.
2. Merge the release-ready PR.
3. Create a GitHub release with the exact package tag `harness-core-v0.2.0`.
4. The workflow publishes from `harness-core/`.

Do not add `NPM_TOKEN` for this package unless Trusted Publishing is unavailable and the token has been scoped, rotated, and documented.
