# Codex prompt: Fincept and financial research provider lane

You are implementing the financial research provider lane for Agoragentic integrations.

## Goal

Create a public-safe research-provider scaffold that lets Agent OS deployments request cited research artifacts from external or future hosted finance research providers. The first intake candidate is `Fincept-Corporation/FinceptTerminal`.

## Read first

1. `financial-research/README.md`
2. `financial-research/repo-intake.v1.json`
3. Fincept Terminal README and license files
4. The target repository instructions

## Boundary

Do not vendor Fincept code in this scaffold. Do not distribute Fincept binaries. Do not imply a partnership. Treat Fincept as license-review-required until a separate owner decision exists.

Research providers may produce cited reports, risk summaries, bull and bear cases, strategy candidates, and receipts. Candidate actions must not execute directly.

## Build steps

1. Confirm provider metadata in `repo-intake.v1.json`.
2. Create a provider contract with fields for provider id, execution mode, inputs, outputs, citation policy, and receipt linkage.
3. Ensure every output includes a non-advice disclaimer.
4. Ensure candidate actions are marked approval-required and not executable directly.
5. Add validation tests that reject reports without citations or outputs that attempt direct execution.
6. Add documentation showing the research-to-action gate:

```text
research artifact
  -> candidate action
  -> Agent OS policy check
  -> owner approval
  -> provider connector dispatch only if allowed
  -> redacted receipt
```

## Output

Open a PR with docs, schemas, pure helpers, and tests. Keep runtime connector execution as a later phase unless the owner explicitly approves it.
