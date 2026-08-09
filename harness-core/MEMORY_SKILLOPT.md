# Agoragentic Memory to SkillOpt bridge

Harness Core can turn an explicit operator-supplied selection of public, evidence-backed Agoragentic Memory claims into an unreviewed SkillOpt task draft. It can also normalize a completed SkillOpt-Sleep `--json` CLI summary into the existing Harness evaluation evidence and attach that evidence to a local receipt.

The bridge is source-only and review-gated. It does not call a model or provider, run SkillOpt, mark tasks reviewed, adopt or publish a skill, mutate Memory, invoke the Router, or spend.

## Pinned compatibility

- Agoragentic Memory `0.1.0-rc.2`, source revision `508ac3667a5ad3f6f5da323d7ddaf5f13384095d`, bounded export schema `agoragentic.memory.export.v1`;
- Microsoft SkillOpt `0.2.0`, source revision `47fe269d75d3def79ffd90236261d26d84868ae5`, task format `skillopt_sleep.tasks.v1`.

Other versions and source revisions require a reviewed compatibility update. The Memory export does not carry producer version or source revision, so the emitted pin is a declared adapter compatibility boundary, not verified provenance. The generated file always has `reviewed: false`, which means the pinned SkillOpt backend must refuse to use it until a human has reviewed the task text and deliberately changed that field outside this bridge.

## Export a task draft

Create a selection file that names only the public Memory claims you intend to expose. The bridge validates the file but does not authenticate who created it:

```json
{
  "schema": "agoragentic.memory-skillopt.selection.v1",
  "memory_project_id": "agoragentic-public",
  "skillopt_project": "example-project",
  "target_skill_path": ".agents/skills/example/SKILL.md",
  "tasks": [
    {
      "memory_id": "mem_11111111111111111111111111111111",
      "split": "train",
      "skill_hint": "example-skill"
    },
    {
      "memory_id": "mem_22222222222222222222222222222222",
      "split": "val",
      "skill_hint": "example-skill"
    }
  ]
}
```

Then run:

```bash
agoragentic-memory-skillopt export-tasks \
  --memory-export memory-export.json \
  --selection memory-skillopt-selection.json \
  --output skillopt-tasks.unreviewed.json
```

The command fails closed unless all selected claims:

- are present in the named Memory project;
- have `sensitivity: "public"`;
- are task-like claims with at least one evidence reference;
- pass bounded secret-shaped and instruction-shaped text checks;
- include both a training split and a held-out validation or test split.

The output retains the selected public task text, selected Memory IDs, a deterministic hash of a public-safe projection of only the selected claims, and pinned compatibility metadata. Unselected claims and events do not influence that hash. The output excludes repository IDs, Memory events, evidence bodies, source sessions, raw transcripts, prompts, tool output, and credentials.

## Attach a SkillOpt report

After an owner has separately reviewed the tasks and run the pinned SkillOpt version under its own policy, capture the `--json` CLI summary and attach that summary to a Harness local receipt. The staged SkillOpt dataclass `report.json` has a different field shape and is not this adapter's input:

```bash
agoragentic-memory-skillopt attach-report \
  --report skillopt-report.json \
  --receipt .agoragentic/local-receipt.json \
  --producer-version 0.2.0 \
  --source-revision 47fe269d75d3def79ffd90236261d26d84868ae5 \
  --analyzed-revision 0123456789abcdef0123456789abcdef01234567 \
  --output .agoragentic/local-receipt.skillopt.json
```

The adapter hashes the complete summary but does not retain raw edits, notes, staging paths, task-file paths, or optimizer rationale. It fails on an unreviewed task file, observed adoption, non-gated acceptance such as `greedy_applied`, inconsistent gate evidence, holdout leakage, too few tasks, or a regressed candidate score. The pinned native CLI summary currently omits `holdout_leaked`; an unaugmented native summary therefore requires review rather than passing. A rejected candidate also requires review.

The producer version and revision are required operator assertions and must match the supported pin; the report does not prove them itself. The adapter trusts the supplied report only as input evidence. A `pass` does not independently prove that the owner reviewed the tasks, SkillOpt ran correctly, the holdout was isolated, the proposed skill is safe, or the skill should be adopted. Adoption and publication remain separate owner decisions.

## Schemas

- [`schema/memory-skillopt-selection.v1.json`](schema/memory-skillopt-selection.v1.json)
- [`schema/memory-skillopt-task-draft.v1.json`](schema/memory-skillopt-task-draft.v1.json)

The task-draft schema closes all nested provenance and authority objects. Unknown authority fields are rejected.
