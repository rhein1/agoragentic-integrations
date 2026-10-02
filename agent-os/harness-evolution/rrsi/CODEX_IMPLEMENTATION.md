# Codex work order: governed RRSI for Fable-5

## Mission

Continue from the tested source-only scaffold in this directory. Build the smallest end-to-end **Fable-5/Codex harness experiment** that can propose a bounded change, evaluate it independently, preserve rejected hypotheses, and produce a reviewable promotion request. Do not create a parallel runtime, memory database or ungoverned self-modifying agent. Do not stop at another planning document: implement and test every source-only tranche possible, opening focused PRs for the real code.

The owner authorized implementation preparation and GitHub work. This is not a grant for paid inference, cloud provisioning, customer-data export, installed-plugin modification, promotion, publication, main-branch writes, deployment, or autonomous contact. Missing live credentials/budget/host qualification is a blocker for that tranche only, not a reason to skip the source implementation and tests.

## Repository ownership and mandatory inspection

Read each repository's current instructions, exact changed files and all relevant callers. Preserve independent work and existing merge gates. Record initial/final HEAD and dirty state per repo; never assume a referenced PR has merged.

| Repo | Inspect before implementation | Owns |
|---|---|---|
| `agoragentic-integrations` | `AGENTS.md`, `integrations.json`, `integrations.schema.json`, this directory, `agent-os/README.md`, `agent-os/openshell/` only if present on the selected ref | Reusable external RRSI adapter, no-spend contract tests and source provenance |
| `fable5-codex` | `AGENTS.md`, `benchmarks/README.md`, **entire** `scripts/run-benchmarks.ps1`, `scripts/validate-package.ps1`, `plugins/fable5-codex/references/ecf-run-contract.md`, six workflow skills, schema, current test/CI entrypoints and open PRs | Evaluator and prompt-fragment composition without weakening six workflows, model choices, worker limits, ECF or evidence rules |
| `agoragentic-memory` | `docs/SKILLOPT_BRIDGE.md`, `plugins/agoragentic-memory/src/skillopt/bridge.cjs`, miners, review/claim/rollback code and tests | Durable scoped hypothesis/evidence continuity, review-aware staging, retention/correction/deletion |
| Standalone Harness Core / ECF / Risk Fork | Discover actual current APIs and evidence/authority contracts before choosing imports | Existing host observation and policy controls; no substitute boolean approval scheme |
| Private platform, later only | Existing provider/authority paths and OpenShell follow-up work | Optional production role integration; private internals never copied here |

Keep the reusable Python code here. Proposed Fable experiment code belongs under `plugins/fable5-codex/experiments/rrsi/` per Fable packaging rules, with tests in the repository's existing test layout. This is a proposed path, not an already implemented API. No wholesale Fable fork.

## Verified upstream facts to preserve

Pinned RRSI: `be50316e1db05914068a973f322770ef08ed7ba1`. See the lock for reviewed blob IDs and line scopes. Read the remaining full loop/proposer/critic/history/gitops/calibration files before wrapping or modifying them; this scaffold did not audit the entire upstream codebase.

- `Domain` supplies task IDs, `run`, `score -> (dict[task_id, TaskResult], extra)`, trace methods, smoke, component signals and guards.
- `Run` stages `domains/<name>/<harness_path>` and advances `evolve/<name>`. A `harness_dir` override alone does not change all hard-coded paths. Baseline/round constructors and methods write local state.
- `round(dry_run=True)` performs analysis before stopping. It is not no-spend/no-side-effect mode. Raw upstream CLI access is not the proposed safe entrypoint.
- Algorithm 2 uses a noise-adjusted best-score floor and a within-band shaped rule. Keep upstream selection separate from installation/promotion authority. Its `ACCEPTED` history means experiment incumbent, not an installed skill or owner approval.
- Missing cost becomes zero relative change upstream; aggregation omits zero/non-positive tokens. Until corrected/qualified for this domain, refuse such comparisons. Do not silently turn missing cost into savings.
- Upstream default search-role models and permissive parameter defaults are not the owner's approved Codex configuration. Unknown JSON keys become notes, so `enabled:false` in a raw config is not an enforcement gate.

## P0 — finish the offline contract and source setup

1. Run the scaffold tests and preview. Run upstream ABI tests against the pinned source; report any skipped tests explicitly.
2. Create an isolated experiment-repository layout with a sanitized, content-addressed snapshot of the selected Fable baseline under `domains/agoragentic/harness/`. Snapshot a reviewed exact allowlist only; never clone customer repos, `.git` credentials, Memory state or the installed personal plugin into a candidate sandbox.
3. Implement a host-owned manifest builder that records actual baseline tree, candidate tree, diff, file modes, model/provider/version/effort, CLI version, policy, evaluator, dataset/split/family, source grant, resource limits, seeds and trial identities. The existing request/diff digests are declarations; verify actual bytes independently.
4. Separate immutable base Fable instructions and host authority constraints from optimizable prompt fragments. Initially permit only `harness/prompts/strategy.md` and `harness/prompts/context.md`; prove candidate composition cannot delete, override, truncate or elevate instructions over the ECF/evidence contract.
5. Verify every actual changed path and mode: reject unknown paths, symlinks/reparse points, submodules, renames outside scope, path normalization collisions, case aliases, dirty baseline changes, excessive diff bytes, and hidden modifications outside the declared edits. A path allowlist alone does not validate the content.
6. Keep the mutation budget aligned with the number of independently tagged edits, not file count. Require bounded hypothesis statements in the private evidence ledger plus opaque IDs in public packets. Add exact diff-to-component tests so prompt text cannot claim structural novelty.

Acceptance: deterministic packets, no source/model/Git side effects on denial, actual source/diff binding tests, Windows/POSIX path tests, and unchanged Fable evidence/authority behavior. Do not claim a live RRSI run.

## P1 — independent evaluator and result importer

1. Build a small task suite covering: evidence-backed findings, false-positive/refutation handling, stale-claim verification, missing-file honesty, context-retention across bounded handoffs, unauthorized-action refusal, and cost/timeout reporting. Include adversarial cases that reward not inventing a finding.
2. Split by repository/problem family, not random near-duplicate rows. Keep evolve, held-out and OOD data disjoint; detect content duplicates/near-duplicates and shared answer leakage. Freeze and hash evaluator, tasks, weights and split manifest before search.
3. Use factual assertions, execution checks and blinded independent/human adjudication where semantics require it. Score `[0,1]` with a predeclared definition. Fable's existing regex/heading benchmark remains a smoke test, never the primary optimization objective.
4. Give baseline and candidate the same model/provider/version, reasoning effort, worker settings, tool access, seeds/order policy, retry policy, timeout and test inputs. Freeze the backbone model; do not let the search quietly switch models or add workers to win.
5. Trials must run from identical clean initial state. Holdout task contents, graders, answer keys and prior answers must not be mounted in the candidate/proposer/critic. Cap holdout queries; seal a candidate before a heldout check. Repeatedly reacting to holdout feedback turns it into training data and requires a fresh holdout.
6. Implement a host-observed result importer. Bind each trial to the exact experiment, request, candidate, evaluator, split, model config, seed and attempt. Require a terminal result, output digest, actual cost/token data and independent safety checks. Replayed/self-hashed/caller-asserted reports are not trusted receipts.
7. Missing/crashed/timed-out trials retain zero reward and the fixed denominator. Unknown cost blocks acceptance. Record all retry costs and count failed attempts under the predeclared policy; do not overwrite them with only the successful attempt.
8. Maintain hard non-compensatory guards for authority, privacy, evidence fidelity, unsupported claims and critical regressions. A quality gain, cheaper run or novelty never offsets these violations. Preserve unknown/unavailable evidence as blockers.

Acceptance: hand-calculated aggregation fixtures, duplicate/missing/stale/invalid/nonfinite/negative/bool-cost tests, cross-arm/cross-split rejection, independent semantic scoring checks, immutable evaluation configuration, and no fabricated runtime observations. Live `score` must not read candidate-controlled files as trusted input.

## P2 — host-controlled RRSI orchestration

1. Use pinned upstream scheduling, history, proposal/critic flow, selection and pruning rather than cloning the algorithm into this integration. Add only a minimal reviewed host wrapper or extension where a real hook is absent. Document any departure from the paper.
2. Gate the **entire** operation before creating an upstream `Run`, accessing private evidence, starting analyst/proposer/critic/model work, or creating worktrees. A Domain.run check is insufficient. Search roles themselves can read/write/run tools and therefore need isolation and least privilege, not only candidate evaluators.
3. Do not accept arbitrary callback/client objects, module paths or `approved:true` as authorization. Bind an authenticated owner grant to exact repository/snapshot/policy/model/data/resource scope with expiry and revocation. Use the existing authority system; do not invent keys, signatures, production secrets or a parallel approval service.
4. Host state is outside candidate write scope. Evaluators, critics, policies, budgets, split manifests, history, cost meters, allowlists, signing material and promotion logic are immutable to the candidate. Critic prompts and tool outputs are untrusted data; regex checks are one layer, not proof of leakage freedom.
5. Reserve an all-in budget atomically before every paid call/parallel launch. Include analyst, proposer, critic, repairs, policy trials, judge, retries and infrastructure. Use a provider-supported hard cap where available; cancellation alone is not proof no extra billing occurred. Unknown costs suspend scheduling.
6. Calibrate noise from repeated frozen-baseline trials using the target suite. Do not import the paper's delta values or tune delta/weights on the holdout. `experiment.template.json` is proposed configuration, not a calibrated or approved run. Record every override.
7. Prevent stale cache reuse. Existing upstream filename/job existence is not adequate binding: check run/candidate/model/evaluator/split/source/seed/attempt/version digests before any resumed analysis, trial, selection or re-adjudication. A changed configuration starts a distinct experiment lineage.
8. Keep `evolve/agoragentic` only inside a disposable experiment repo. `fast_forward`, `readjudicate`, `reevaluate`, retry and resume paths require the same host authorization; none may update a production branch or installed plugin. Apply STOP/revocation/expiry between rounds, calls and mutations, not merely once at startup.
9. Separate state transitions: proposed -> screened -> evaluated -> selected_experiment_candidate -> heldout_qualified -> owner_review_required -> approved_for_exact_promotion -> independently_verified_install. Every failure stays explicit; no missing event implies completion.

Acceptance: denied calls make zero provider/process/repository mutations; expired/replayed grants and state changes fail; all alternate commands/resume paths are covered; cancellation has verified process/resource cleanup; budget reservation withstands parallelism. No paid run is authorized by this work order.

## P3 — bounded execution host and no-money qualification

OpenShell is optional until independently qualified. PR #435 is not merged or runtime-ready; its broader validation failed in `Validate MCP package` at the inspected head. Fix/verify that dependency in its own scope; do not inherit its green targeted tests as live containment proof.

1. Define an execution-host interface with explicit result/denial/unknown outcomes. The scaffold's hard-off adapter stays off. No fallback to an unsandboxed shell on host failure.
2. Start with a disposable local, synthetic, credential-free lifecycle test; do not use paid APIs just to demonstrate the loop. For OpenShell, require the real pinned image/gateway/SDK, host policy qualification and explicit lab-resource authorization from its own workstream.
3. Prove evaluator and proposer isolation separately: no protected files, host Docker socket, wallet/signing material, production data, unapproved egress, model credentials, heldout answers or sibling tenant state. Gateway credentials belong to the host, not to workers.
4. Enforce actual CPU/memory/storage/egress/time/output quotas. Test timeout, process-tree termination, dropped terminal events, revocation, redirects/rebinding, orphaned resources and identity-safe deletion. Worktrees and command timeouts are not these controls.

Acceptance: evidence-bound allowed and denied operations plus independently checked cleanup. Record actual provider/model/host versions and evidence classes. Local tests alone do not establish containment.

## P4 — Memory continuity and owner-gated promotion

1. Implement a review-aware import/export through existing Memory staging contracts. Verify current review claim, source retention/redaction state, repo/scope, expiry, correction and revocation. The existing reviewed task schema is not an RRSI execution permit; reject legacy unbound/truncated/unreviewed artifacts.
2. Persist hypothesis, component, baseline/candidate/diff, task/evaluator/model provenance, measured costs/rewards, rejection reasons, and experiment verdict with evidence references. Keep raw transcripts/prompts/tool outputs, secrets and private data out of public GitHub and unapproved model contexts.
3. Store falsified hypotheses with their scope/version/evidence and invalidate them appropriately when those assumptions change. Do not suppress all future exploration based on one unrelated failure. Memory retrieval is context, not instruction or routing authority.
4. Preserve append-only trial and decision lineage in host-owned storage. RRSI history/re-adjudication behavior must not erase the audit trail. Prune only evolvable mechanisms, never failed trials, hard safety rules or evidence needed for accountability.
5. Produce a PR with the exact candidate diff, baseline, test results, all-in costs, heldout/OOD evidence, remaining unknowns and rollback artifact. There is no automatic installed-skill/main/marketplace promotion. Owner review must bind the exact commit/aggregate version and policy, not a mutable branch name.
6. Before the authorized install, recheck changed sources, current grant, target identity, policy and baseline; use compare-and-swap semantics. Record an independent post-install reload observation bound to that exact version. Rollback restores the exact prior aggregate and verifies it; a rollback record alone is not restored filesystem state.

Acceptance: stale/revoked/cross-repo grants, interrupted finalization, concurrent promotion, version drift, source deletion and rollback are tested; no `verified_done`, settlement, trust or production claims arise from local RRSI scores.

## Delivery and stop conditions

Finish source-only P0/P1 and host-wrapper tests before asking for any new resource. Open focused PRs in the owning repositories; do not merge or launch production. Check required CI on each exact final head, including full packaging and pre-existing suites. In integrations, run the schema, capability-status, count, rename-preflight and documentation-link checks; regenerate affected artifacts rather than bypass the gates. In Fable, run `scripts/validate-package.ps1` and the existing test/packed-artifact checks.

Stop live execution on missing authority, unavailable isolation, unverifiable provenance, incomplete costs, data leakage, stale baseline/evaluator, missing terminal status or cleanup uncertainty. Report the blocker without pretending that a simulator or self-hash satisfies it.

Final report must distinguish: implemented source; local tests; upstream ABI tests; hosted CI; mocked ordering; real Codex run; provider/host containment; merged; installed; deployed. Include exact commands, counts, skipped tests, commits, PRs, evidence paths, actual model/CLI/host configuration, measured versus assumed costs, and rollback state. Preserve unknowns and refuted findings. Use real subagents only when available; otherwise report single-agent multi-lens work.
