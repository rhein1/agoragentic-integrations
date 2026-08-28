# Harness Core extraction record

This directory is the retained historical record for issue
[#238](https://github.com/rhein1/agoragentic-integrations/issues/238). The preparation tooling and
standalone overlay were removed after the cutover completed; they are no longer active build or
release surfaces.

Current canonical state:

- Source: <https://github.com/rhein1/agoragentic-harness-core>
- Current release: <https://github.com/rhein1/agoragentic-harness-core/releases/tag/v0.4.2>
- npm: <https://www.npmjs.com/package/agoragentic-harness-core>
- Historical `0.3.1` cutover evidence: [`../../harness-core/STANDALONE_RELEASE_EVIDENCE.json`](../../harness-core/STANDALONE_RELEASE_EVIDENCE.json)
- Current `0.4.2` release evidence: [`../../harness-core/CURRENT_RELEASE_EVIDENCE.json`](../../harness-core/CURRENT_RELEASE_EVIDENCE.json)
- Legacy source pointer: [`../../harness-core/README.md`](../../harness-core/README.md)

The standalone package keeps the existing package name, CLI aliases, exports, schemas, and
Apache-2.0 license. This repository no longer contains a second canonical implementation or a
Harness Core publishing workflow.

The extraction and repository move grant no runtime, provider, wallet, x402, deployment,
publication, settlement, trust, hosted-memory, or owner-approval-bypass authority.
