# Agoragentic Cohort Assurance — Resolution Desk synthetic system-behavior proof

**Offline tooling checkpoint; external proof pending.** The 32 checked-in records
are authored evaluator fixtures for testing replay, including failed, timed-out,
abandoned, invalid, and unverifiable outcomes. They are not model-generated trial
results, target invocations, independently verified receipts, or a live Resolution
Desk assessment. `live_trials_completed` is zero; all 32 live trials are missing.

This proof is a model-mediated synthetic stress test of an exact system version.
The personas do not speak for, represent, or replace real users or affected
communities. That describes the intended future proof; this checkpoint only
checks fixture consistency and does not establish model-mediated evidence.

From a source checkout with Python 3.11 or later:

```bash
python matraix-cohort-assurance/proofs/resolution-desk-missing-delivery-v1/replay.py
python -m unittest discover -s matraix-cohort-assurance/proofs/resolution-desk-missing-delivery-v1/tests -v
```

Replay verifies the SHA-256 manifest and reproduces the exact `report.json` bytes.
`--out /path/to/new-report.json` writes only a previously nonexistent file.
The manifest is unsigned local integrity evidence, not third-party authenticity.
The implementation reuses the existing adapter's canonical JSON and target policy.
It has no network client, target dispatcher, provider import, or live flag.

The checked-in `synthetic-cohort-evidence.json` is derived only from those 32
fixtures. `platform-contract.json` pins the exact Marketplace contract commit.
The GitHub workflow checks out that commit and runs its actual validator through
`validate-platform-contract.cjs`; it does not copy platform business logic or
make a model or target call.

Read [METHOD.md](METHOD.md) and [LIMITATIONS.md](LIMITATIONS.md). Platform schema
and semantic eligibility conformance are pinned to Marketplace commit
`71799e0099ce30cd4e76e19e209e87122afce7b1`. CI uses a byte-hash-pinned schema
snapshot because its repository-scoped token cannot read the private platform repo.
Live model trials and independent
review remain pending, so PR #321 must remain draft.
