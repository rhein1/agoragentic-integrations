# Scoped RRSI implementation instructions

Follow the repository's AGENTS.md and [CODEX_IMPLEMENTATION.md](CODEX_IMPLEMENTATION.md). This directory is source-only preparation. Implement the offline and host-contract tranches before live-resource work; do not replace this work order with another design-only scaffold.

Start with `python -m unittest discover -s agent-os/harness-evolution/rrsi/tests -v` and the fixture preview from README. Record skipped ABI tests unless `RRSI_CONTRACT_ROOT` points to the pinned verified contract source.

Do not invoke upstream `rrsi.py` (including its dry-run), install external model packages, read user transcripts/credentials, run paid benchmarks, enable OpenShell, edit installed Fable skills, or promote/merge/publish from this work order. Upstream analysis can make paid calls before Domain.run is reached. Qualified host authority, a separately approved budget and explicit data scope are required for live work.

Treat fixture observations, hashes, local owner-review assertions and selected experiment candidates as distinct from authenticated runtime evidence, execution permission and installed production state. Never set a flag to pretend a missing host/evidence gate has passed. Preserve independent repository work and existing Fable/Memory/ECF authority boundaries.
