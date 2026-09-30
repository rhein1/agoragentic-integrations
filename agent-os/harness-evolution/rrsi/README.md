# RRSI preparation for Fable-5 / Codex

**Implemented: offline experiment packets, synthetic evidence replay, an inert RRSI Domain adapter, source-only host gate and budget simulations, and a quarantined Memory review importer. Not implemented: authenticated host authority, live search, model execution, isolation, authenticated evidence ingestion, or promotion.** No package installation or credentials are needed for the local preview. Nothing here enables agents to modify their own authority.

RRSI is an optimizer of harnesses, not another agent runtime. The initial optimization target is **Fable-5/Codex**. The reusable bridge belongs here; Fable owns its six workflows and evaluator; Memory owns durable evidence-linked continuity; existing ECF/Risk Fork and host controls own permission checks; a separately qualified OpenShell host can later supply isolation. Production Interchange roles come after the Fable experiment, not before it.

## Start here

From the repository root, using Python 3.10 or newer:

```sh
python -m unittest discover -s agent-os/harness-evolution/rrsi/tests -v
python agent-os/harness-evolution/rrsi/preview.py agent-os/harness-evolution/rrsi/fixture.json
```

Without `RRSI_CONTRACT_ROOT`, four upstream-ABI tests are explicitly skipped; all offline tests still run. For the ABI checks, point that variable at an already-reviewed local checkout of the pinned RRSI revision. CI checks out that exact revision, verifies the two contract file blobs, and executes only those two pure modules, not upstream package initialization or its model/search loop.

```sh
RRSI_CONTRACT_ROOT=/path/to/reviewed/rrsi python -m unittest discover -s agent-os/harness-evolution/rrsi/tests -v
```

The fixture's commits, digests, trials, rewards, costs, task families and identifiers are **synthetic**. Its score difference is not a Fable improvement. Preview produces an experiment packet, an offline replay, and a proposed history record. It writes none of them to Memory or Git. There is no `run`, `apply`, `approve`, install, or promotion command.

**Give Codex [CODEX_IMPLEMENTATION.md](CODEX_IMPLEMENTATION.md).** It contains the execution order, repository ownership, concrete source paths, experiment design, acceptance tests, and stop conditions. [upstream.lock.json](upstream.lock.json) records the reviewed upstream interfaces and dependency states. [experiment.template.json](experiment.template.json) is an unapproved future RRSI configuration template, deliberately not an active `rrsi.json`.

## Important corrections to the initial integration idea

1. **The selector is not a strict "every winner improves quality" rule.** Upstream Algorithm 2 allows candidates inside a noise band when its shaped cost/novelty rule passes, subject to the score floor and domain guards. Preserve the actual equations; do not silently replace them with a different selector or claim all accepted edits raise score.
2. **Missing cost is unsafe as an acceptance signal.** Upstream `relative_cost_change` returns zero if either count is absent/zero; aggregation excludes non-positive token observations. This bridge reports missing costs as unknown, keeps missing trials in the reward denominator, includes known costs of incomplete trials in campaign budgets, and blocks incomplete/zero-token comparisons rather than treating them as free improvements.
3. **A Domain adapter is not the whole host boundary.** The upstream loop can call its analyst and write files before `Domain.run`; even its round-level `dry_run` happens after analysis. Never use the upstream CLI's dry-run as a no-spend guarantee. Gate the entire orchestrator before constructing `Run`, not just candidate evaluation.
4. **Git worktrees are not isolation.** The core assumes `domains/<name>/<harness_path>` and an `evolve/<name>` branch. Overriding `Domain.harness_dir` alone does not remove the loop's hard-coded relative path. Stage a sanitized harness export in a disposable experiment repository; never run this against the live Fable checkout, user plugin directory, Memory database, or platform repo.
5. **Fable's existing lexical benchmark is smoke evidence, not the objective.** Reuse its isolation/provenance patterns where appropriate, but build blind correctness/evidence tasks and separate family-disjoint held-out/OOD evaluation. Optimizing known headings or regex keywords would recreate the overfitting problem.
6. **Reuse Memory's staged-review boundary.** A reviewed SkillOpt task remains staged, not active; it does not authorize RRSI, a model call, or publication. The review-aware importer validates a supplied artifact chain and still quarantines it without execution permission.

## Source-only host and Memory implementation

`domain/host.py` keeps `HostOrchestrator.start`, resume, revoke and invoke hard-off
before upstream construction, authority callbacks, filesystem, model or budget
effects. The actual host authorization adapter is not implemented. An arbitrary
callback or caller `approved`/`authenticated` field cannot replace that adapter.

`SyntheticHostSession` is an executable offline state machine for an illustrative
candidate cycle: analysis, worktree, proposal, critic, training evaluation,
selection and sealed evaluation. It records no real work in those phases. Each
advance checks a synthetic scope/grant observation and reserves all-in estimates
before recording a step. Failures retain settled costs; unknown results suspend
the shared budget until explicit reconciliation. Resume binds the exact state
checkpoint and scope and rejects expired/revoked grants, changed grant identity,
or regressed revisions. Same-session transitions are serialized. Its completion
state is simulation completion, never permission or a measured improvement.

`BudgetStore` is a process-local test double. Reservations are atomic and exposed
as immutable snapshots; settled consumption accumulates across phases, retries,
and sessions. Overruns suspend new reservations and reconciliation records the
full consumption even when it exceeds the campaign cap. Release is only for
known unused reservations. A real host needs durable transactional storage,
trusted metering, authenticated grants and crash recovery; this module supplies
none of those production claims.

`domain/memory_bridge.py` validates the supplied Memory stage, reviewed task,
finalization claim, review, receipt, and current stage-view projection against
the public SkillOpt shapes pinned to Memory commit
`3c2f17d82476d22996377ea7c07cb601ed625483`. It checks artifact digests, scope,
baseline/rollback linkage, redaction and review freshness. The caller must obtain
the current artifacts from the owning Memory host; self-consistent JSON does not
authenticate them. Results remain quarantined with `evaluation_allowed: false`,
`promotion_allowed: false` and no Memory write. Live host attestation and policy
checks remain necessary, including retention and review state at dispatch time.

The checked-in Memory fixture was generated by the pinned public bridge's real
`createStage`, `reviewStage`, `inspectStage`, and `stageView` functions in a
disposable synthetic directory. Its digests are the original Node-produced
values; only unbound absolute path projections were replaced with synthetic
paths. Tests validate that packet rather than relying solely on hashes computed
by this Python importer. No user Memory records were involved. The importer
supports bounded JSON with safe integer numbers and ASCII object keys; it rejects
unsupported numeric/key forms rather than silently applying different Python
and JavaScript canonicalization rules.

## Source contract, not a live integration

`domain/adapter.py` subclasses upstream `Domain` and converts validated fixture slots into actual upstream `TaskResult` objects. `score` accepts only preloaded synthetic evolve observations; `run` raises; `smoke` returns false; `guards` always includes `qualified_host_evidence_missing`. `heldout_ids` exposes nothing, and trace methods return fixed non-sensitive text. `DOMAIN` starts unconfigured, with no import-time I/O.

The adapter imports `rrsi.domain` and `rrsi.evaluate`; those must come from an approved pinned environment when used outside the test harness. It does not itself authenticate a whole installed package. `verify_contract.py` checks exactly two source files, not the entire dependency tree. No upstream source is vendored here.

`domain/contract.py` binds a proposed experiment to baseline/candidate Git commits, policy/evaluator/model-configuration digests, declared edit digests, split manifests, and budget requirements. It permits only two declared prompt-fragment paths at this stage. These declarations are **not a measured Git diff**: the future host must recompute actual changed paths/content/modes and reject symlinks, renames, submodules, dirty-tree drift and protected-file changes. A hash does not establish authenticity, full coverage, semantic correctness, consent, or enforcement.

The packet hides held-out/OOD task identifiers, but the input manifest contains synthetic split labels. A real evaluator must keep its private task contents and feedback inaccessible to proposers, critics, and candidates. Declared family IDs are a local consistency check, not proof that datasets lack duplicates.

Replay uses uniform per-trial weights and rewards in `[0,1]`. It is not a complete reproduction of upstream weighted benchmark behavior, calibration, selection, history, novelty or pruning; those remain upstream responsibilities. Local safety/cost checks are additional non-compensatory prerequisites. Actual all-in costs must include proposer, analyst, critic, retries, policy, judge and infrastructure, not merely the policy-token metric used by RRSI.

## Ownership and dependency state

| Responsibility | Repository / state observed September 29, 2026 |
|---|---|
| Reusable offline boundary and RRSI ABI | This directory in `agoragentic-integrations` |
| Frozen base workflows, evaluation runner, candidate composition | `rhein1/fable5-codex`; main inspected at `154bf0b220566d91d1a4aaf4390d9c3a54926c3a` |
| Memory review-aware history bridge | Offline artifact-chain validator in `domain/memory_bridge.py`; no live consumer or Memory write |
| Local execution/evidence contracts | Standalone Harness Core and ECF/Risk Fork; inspect actual contracts before importing |
| Optional isolation | OpenShell PR #435 is draft/unmerged. Its targeted four-job suite and CodeQL passed, but Validate Machine Surfaces failed in the MCP package step; later validation steps were skipped. No live OpenShell host is qualified |

The implementation does not depend on unmerged OpenShell or Fable Context Keeper work. Re-read current PRs before implementation; #22/#23 were open when inspected and must not be silently included in a baseline. The parent Agent OS catalog is unchanged: this is a nested source-only preparation surface, not a new supported integration, registry package, or product.

## Primary sources

- [Pinned RRSI Domain interface](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/domain.py)
- [Pinned evaluation and missing-cost behavior](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/evaluate.py)
- [Pinned selector](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/selection.py)
- [Pinned loop and promotion behavior](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/loop.py)
- [Paper](https://arxiv.org/abs/2609.24972)
- [Fable benchmark limitations](https://github.com/rhein1/fable5-codex/blob/154bf0b220566d91d1a4aaf4390d9c3a54926c3a/benchmarks/README.md)
- [Memory reviewed-task boundary](https://github.com/rhein1/agoragentic-memory/blob/3c2f17d82476d22996377ea7c07cb601ed625483/docs/SKILLOPT_BRIDGE.md)

The paper's reported improvements use its own configurations and benchmarks. None have been reproduced for Agoragentic or Codex here. No endorsement by Google, NVIDIA or OpenAI is implied.
