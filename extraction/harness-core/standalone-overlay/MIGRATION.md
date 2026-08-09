# Migration from agoragentic-integrations

The npm package name and supported CLI/schema imports remain `agoragentic-harness-core`. Existing package
consumers do not need to change imports when the standalone repository becomes canonical.

## Source consumers

Before the standalone release is verified, the canonical source remains:

`https://github.com/rhein1/agoragentic-integrations/tree/main/harness-core`

After cutover, use:

`https://github.com/rhein1/agoragentic-harness-core`

Framework mapping examples move from `examples/harness-core-frameworks/` in the integrations repository
to `examples/frameworks/` here. Historical integrations-repository links will be preserved through a thin
pointer and migration document after the standalone package is proven.

## Release compatibility

- Package name: unchanged.
- CLI bins: unchanged.
- Exported kernel, adapter, evaluation, Memory-SkillOpt, and schema subpaths: unchanged.
- License: Apache-2.0, unchanged.
- Repository, homepage, issue tracker, releases, and trusted publisher: move to the standalone repository.

Do not interpret repository extraction as new runtime, provider, wallet, payment, deployment, publication,
trust, or owner-bypass authority.
