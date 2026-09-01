# Harness Core has moved

Harness Core is now maintained in its standalone canonical repository:

- Source: <https://github.com/rhein1/agoragentic-harness-core>
- npm: <https://www.npmjs.com/package/agoragentic-harness-core>
- Current release: <https://github.com/rhein1/agoragentic-harness-core/releases/tag/v0.4.2>
- Migration guide: <https://github.com/rhein1/agoragentic-harness-core/blob/main/MIGRATION.md>
- Schemas and API exports: <https://github.com/rhein1/agoragentic-harness-core/tree/main/schema>

Install and run the published package:

```bash
npx agoragentic-harness-core@latest init
npx agoragentic-harness-core@latest validate
npx agoragentic-harness-core@latest run \
  --profile local_no_spend \
  --task "Create an evidence-backed readiness summary"
```

The npm package name, four CLI aliases, exported kernel/adapter/evaluation modules, Memory-SkillOpt
surface, and schema subpaths remain compatible. Source consumers should update repository links from
`rhein1/agoragentic-integrations/tree/main/harness-core` to
`rhein1/agoragentic-harness-core`.

This directory is intentionally a thin pointer. It contains no second package manifest, runtime,
binary, schema, profile, template, or test copy. The immutable cutover facts remain in
[`STANDALONE_RELEASE_EVIDENCE.json`](./STANDALONE_RELEASE_EVIDENCE.json); current `0.4.2` release,
provenance, clean-room, protected-publish, and observer-only AHP evidence is in
[`CURRENT_RELEASE_EVIDENCE.json`](./CURRENT_RELEASE_EVIDENCE.json).

Harness Core remains a local, no-spend governance and evidence layer. Its local receipts are not settlement receipts,
certifications, endorsements, marketplace verification, or proof that a host executed a task. It grants no provider
dispatch, wallet, x402, deployment, publication, trust, hosted-memory, or owner-approval-bypass authority.
