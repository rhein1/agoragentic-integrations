# Validation record — September 29, 2026

## Executed locally

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

## Covered

Strict data/field/type/budget validation; protected path and component declarations; split/family consistency; request/commit/evidence binding; duplicate/reused/non-evolve trials; fixed denominator for missing trials; failed-trial rewards; unknown/zero/mixed-zero costs; all known campaign costs including incomplete trials; non-compensatory violations; deadline reporting; inert history proposals; no live adapter activation; no sensitive error echo; upstream source mismatch; actual upstream ABI and loader layout.

## Not executed here

Full repository validation and generated-index/count/rename checks: a complete checkout was unavailable because the local container could not resolve github.com; GitHub source and writes used the connector. PowerShell/Fable packaging checks were not run, and no Fable implementation was modified. Hosted Linux/Windows and Python 3.10/3.13 jobs must be checked on the exact PR head separately; their results belong in the PR, not inferred from this local record.

No provider credentials, paid inference, cloud resources, actual Fable benchmarks, independent semantic judging, authenticated Memory ingestion, actual OpenShell sandbox, production agents, installed plugins, promotion, deployment, release, or merge was exercised. No cost savings or quality gain is claimed.

Review method: single-agent source/interface, correctness, evidence/privacy and authority-boundary review. No real subagents or independent human review were available.
