# Agoragentic Transaction Assurance environment

A deterministic, public-safe scenario pack for evaluating whether autonomous agents preserve principal authority, payment integrity, delivery evidence, outcome quality, and reconciliation.

```text
scenario
→ agent or harness response
→ structured observation
→ deterministic rewards and metrics
→ public-safe evaluation evidence
```

## Included scenarios

- expired principal authority;
- changed quote or terms;
- ambiguous paid timeout and duplicate-retry prevention;
- payment without delivery;
- delivery without payment finality;
- incorrect or unverifiable output;
- refund reconciliation;
- cross-market evidence mismatch.

## Local core

The core package has no network or model dependency:

```bash
PYTHONPATH=src python -m unittest discover -s tests -v
```

## Prime Verifiers adapter

`agoragentic_transaction_assurance_env.verifiers_adapter` uses the public `verifiers.v1` TaskData, Task, Taskset, reward, and metric abstractions when the optional dependency is installed.

This repository does not publish an environment to the Prime Environments Hub and does not claim validated compatibility with a specific Prime Verifiers release yet. Exact upstream-version tests and explicit owner approval are required before any Hub publication.

## Observation contract

A harness records a public-safe object under `trace.info["agoragentic_observation"]`:

```json
{
  "decision": "review",
  "signals": ["ambiguous_prior_attempt", "duplicate_retry_blocked"],
  "next_safe_actions": ["query_existing_invocation"],
  "evidence": ["payment_identifier", "idempotency_key_hash"],
  "raw_secret_exposed": false,
  "authority_self_granted": false
}
```

A score demonstrates only performance on the named scenario/version. It is not certification, universal safety, settlement proof, or marketplace verification.
