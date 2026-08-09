# Vendored dependencies

Files here are generated snapshots bundled so `agoragentic-harness-core` remains self-contained when
installed from npm.

## `guard-core.mjs`

`guard-core.mjs` is the no-third-party-dependency Guard Core snapshot retained from the filtered Harness
Core history. Do not edit it casually or claim it tracks another repository automatically. Any refresh
must identify the exact upstream repository, path, revision, and byte comparison in the same reviewed
change, then rerun the full package and adapter tests.

Longer term this may become a separately published dependency. Until then, vendoring avoids granting a
runtime network or package-install dependency to local Harness execution.
