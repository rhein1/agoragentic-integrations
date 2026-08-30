# Repository Rename Preflight

> **No repository rename has been executed or authorized.** This is a deterministic dependency inventory and rollback plan.

- Source repository: `rhein1/agoragentic-integrations`
- Canonical manifest: `2.51.0` as of `2026-08-30`
- Safe to rename now: **false**
- Authorized target: **none**
- Affected tracked files: **141**
- Exact repository references: **277**

## Reference Classes

| Class | Files |
|---|---:|
| `installer_or_clone` | 28 |
| `machine_discovery` | 45 |
| `package_registry_metadata` | 22 |
| `public_documentation` | 72 |
| `raw_content_url` | 2 |
| `release_or_provenance` | 11 |
| `reusable_action` | 2 |
| `source_or_test` | 19 |

## Reusable Action Blockers

These consumers can fail immediately after a rename and must be migrated first.

| Location | Reference |
|---|---|
| `transaction-assurance/CONFORMANCE.md:101` | `uses: rhein1/agoragentic-integrations/.github/workflows/transaction-assurance-conformance.yml@<SUITE_COMMIT>` |
| `transaction-assurance/examples/external-adopters/anchor-x402/README.md:118` | `uses: rhein1/agoragentic-integrations/.github/workflows/transaction-assurance-conformance.yml@<SUITE_COMMIT>` |

## Raw Content URLs

| Location | Reference |
|---|---|
| `autogen/README.md:9` | `curl -O https://raw.githubusercontent.com/rhein1/agoragentic-integrations/main/autogen/agoragentic_autogen.py` |
| `langchain/README.md:9` | `curl -O https://raw.githubusercontent.com/rhein1/agoragentic-integrations/main/langchain/agoragentic_tools.py` |

## Owner Decisions

- Choose the final owner and repository name; no target is authorized by this packet.
- Choose a compatibility window for package metadata, clone URLs, raw-content URLs, and reusable action consumers.
- Choose whether external consumers receive a deprecation notice before the rename.

## Rollout

1. Freeze unrelated changes and capture the current default-branch SHA.
2. Update reusable action consumers to immutable SHAs or the final repository path before renaming.
3. Rename through GitHub, then update package metadata, installers, raw-content URLs, discovery files, and public documentation.
4. Run repository validation and external no-spend smoke checks against both redirected and canonical URLs.
5. Publish a bounded migration notice that distinguishes redirects from permanent compatibility guarantees.

## Rollback

Trigger: Any broken reusable action, installer, raw-content URL, package metadata, discovery surface, or external no-spend smoke check.

1. Restore the previous GitHub repository name while the redirect remains uncontested.
2. Revert the rename reference commit and republish only metadata that was already changed.
3. Re-run the full validation suite and external no-spend smoke checks before lifting the freeze.

The complete per-file inventory is in [`repository-rename-preflight.json`](./repository-rename-preflight.json).
