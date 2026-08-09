# npm trusted publishing

`agoragentic-harness-core` must publish from GitHub Actions through npm trusted publishing. Do not add an
`NPM_TOKEN`, automation token, or local publish path.

Configure npm with:

- Package: `agoragentic-harness-core`
- GitHub owner: `rhein1`
- Repository: `agoragentic-harness-core`
- Workflow: `.github/workflows/publish.yml`
- Environment: none unless a later reviewed release policy adds one

The workflow accepts only a published GitHub release whose tag exactly equals `v<package.json version>`.
It runs `npm ci`, package tests, framework-example validation, pack smoke, and an npm dry run before
`npm publish --access public --provenance`.

Repository extraction and green CI do not authorize publication. The owner must separately approve the
release, configure the trusted publisher, and verify npm package source metadata after publication.
