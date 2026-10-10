# RRSI validation records

## Current host and Memory contract check - October 2, 2026

Environment: Windows LUX, Python **3.14.2**, Node **24.13.0**. The reviewed
upstream-contract directory contained only `rrsi/domain.py` and
`rrsi/evaluate.py`, retrieved by their pinned Git blob IDs and verified by
`verify_contract_sources` before import. No upstream `rrsi.py` or model loop ran.

```powershell
$env:RRSI_CONTRACT_ROOT = '<isolated directory containing pinned rrsi/domain.py and rrsi/evaluate.py>'
python -m unittest discover -s agent-os/harness-evolution/rrsi/tests -v
python agent-os/harness-evolution/rrsi/preview.py agent-os/harness-evolution/rrsi/fixture.json
node scripts/verify-integrations-json.js
node scripts/sync-integration-counts.mjs --check
node scripts/generate-integration-capability-status.mjs --check
node scripts/verify-client-distribution.mjs
node --test test/verify-doc-links.test.mjs
node --test test/mcp-direct-bypass.test.mjs
```

The current suite passed **61 tests, 0 failures, 0 skips**: 36 offline/ABI
contracts, 14 synthetic host tests, and 11 Memory importer tests. The four
pinned ABI tests passed against the verified pure source subset. The fixture
preview and listed machine-surface checks passed. Without
`RRSI_CONTRACT_ROOT`, those four ABI tests skip; the historical 36-test result
below predates the host and Memory tranches.

The documentation-link tests passed **5/5** and the direct-MCP-bypass tests
passed **11/11**. The Windows checkout has CRLF bytes in the two tracked rename
preflight outputs, so its raw `--check` reported `json=false, markdown=false`.
Regenerating in memory and comparing to the tracked outputs after CRLF-to-LF
normalization matched both exactly (185 files, 369 references); no generated
preflight artifact changed.

The added regressions reject reconciliation below observed cost or token
overruns, retain partial observations on unknown outcomes, block concurrent
reuse of one reservation by separate sessions, and reject stale
stage-view projections, contradictory no-provider/no-spend receipts, and empty
or truncated reviewed tasks even when linked digests are recomputed. The
Memory check reconstructs the task rows emitted by the pinned bridge at
`3c2f17d82476d22996377ea7c07cb601ed625483`; it verifies internal
consistency, not external owner identity or authenticated Memory provenance.
Host authority remains hard-off and imported evidence remains quarantined.

No real Codex run, provider call, paid inference, production host, installed
plugin, publication, or deployment was exercised. Hosted CI on the final PR
head must be checked separately.

## Historical September 29 scaffold check

### Executed locally

Environment: Linux, Python **3.13.5**. No live RRSI model/search loop was run.

```sh
RRSI_CONTRACT_ROOT=/mnt/data/rrsi-work/upstream-contract python -m unittest discover -s agent-os/harness-evolution/rrsi/tests -v
python agent-os/harness-evolution/rrsi/preview.py agent-os/harness-evolution/rrsi/fixture.json
```

Result: **36 tests passed, 0 failed, 0 skipped** with the upstream-contract path set. The preview emitted valid JSON with authority, verification and promotion false. The tests include actual CLI subprocesses and an actual upstream `load_domain` import in a temporary staged domain layout.

The two upstream pure contract files were obtained from GitHub source, reconstructed locally and verified byte-for-byte by Git blob SHA before executing them:

- `rrsi/domain.py`: `faf56eb66581fd0c7655abfd05daca96d4a180dd`
- `rrsi/evaluate.py`: `78cac3848c44d9c0827d60b91211964f6576f348`

This verifies the domain-loader and TaskResult/aggregation interface subset. It is not a full upstream installation, full upstream test suite, security audit, live Codex integration, package supply-chain attestation, or reproduction of research results.

### Covered

Strict data/field/type/budget validation; protected path and component declarations; split/family consistency; request/commit/evidence binding; duplicate/reused/non-evolve trials; fixed denominator for missing trials; failed-trial rewards; unknown/zero/mixed-zero costs; all known campaign costs including incomplete trials; non-compensatory violations; deadline reporting; inert history proposals; no live adapter activation; no sensitive error echo; upstream source mismatch; actual upstream ABI and loader layout.

### Not executed here

Full repository validation and generated-index/count/rename checks: a complete checkout was unavailable because the local container could not resolve github.com; GitHub source and writes used the connector. PowerShell/Fable packaging checks were not run, and no Fable implementation was modified. Hosted Linux/Windows and Python 3.10/3.13 jobs must be checked on the exact PR head separately; their results belong in the PR, not inferred from this local record.

No provider credentials, paid inference, cloud resources, actual Fable benchmarks, independent semantic judging, authenticated Memory ingestion, actual OpenShell sandbox, production agents, installed plugins, promotion, deployment, release, or merge was exercised. No cost savings or quality gain is claimed.

Review method: single-agent source/interface, correctness, evidence/privacy and authority-boundary review. No real subagents or independent human review were available.
