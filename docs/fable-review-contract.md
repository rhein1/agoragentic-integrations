# Fable Review Contract

Use this contract for PR reviews, deep reviews, audits, and reviewer-bot-compatible findings.

## Verdict

The first line of the review must be exactly one of:

```text
LGTM
Needs Updates
```

Use `Needs Updates` when any blocking correctness, security, privacy, data, integration, release, or docs-vs-reality issue remains. Use `LGTM` only when no blocking issue survives the review.

## Required Sections

Include these sections in order:

```text
### Needs Fixing
### Requires Human Review
### Recommended Optional
### Create Follow-up Issue
```

`Needs Fixing` and `Requires Human Review` are blocking. `Recommended Optional` and `Create Follow-up Issue` are non-blocking unless explicitly promoted with evidence.

## Finding Shape

Each blocking finding must include:

- severity: `P0`, `P1`, or `P2`
- file and line citation when source-backed
- the failing invariant
- a concrete failure scenario
- the safest next fix
- validation that would prove the fix

Do not print secret values. State the secret class, file, line, and count if needed.

## Review Discipline

- Review the actual diff/source, not only summaries.
- Keep docs claims tied to source, tests, package metadata, or runtime evidence.
- Preserve rejected candidates when they explain why an apparent issue is not real.
- Separate target-system failures from runner/tooling failures.
- State residual unknowns when the evidence is incomplete.

