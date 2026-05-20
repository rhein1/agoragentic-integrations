# Harness Core Trusted Publishing

`agoragentic-harness-core` is package-ready but should not be published with a long-lived npm token.

## Publication Gate

Publish only after:

- The source scaffold has merged to `main`.
- `npm test` passes in `harness-core/`.
- `npm pack --dry-run` shows only intended files.
- The npm package is configured for Trusted Publishing with this repository and workflow.
- At least one external builder validates the local no-spend flow.

## Expected Trusted Publisher

- npm package: `agoragentic-harness-core`
- GitHub repository: `rhein1/agoragentic-integrations`
- Workflow: `.github/workflows/publish-harness-core.yml`
- Release tag prefix: `harness-core-v`

## Publish Flow

1. Configure npm Trusted Publishing for the package.
2. Merge the release-ready PR.
3. Create a GitHub release with a tag like `harness-core-v0.1.0`.
4. The workflow publishes from `harness-core/`.

Do not add `NPM_TOKEN` for this package unless Trusted Publishing is unavailable and the token has been scoped, rotated, and documented.
