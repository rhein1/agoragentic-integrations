# Financial Research Provider Lane

Status: public scaffold.

This directory documents a public-safe research-provider lane for Agoragentic. The lane lets Agent OS deployments request cited research artifacts from external or future hosted providers without granting direct execution authority.

## V1 boundary

Research providers may produce:

- cited research reports;
- risk summaries;
- bull and bear cases;
- strategy candidates;
- provider receipts;
- non-advice disclaimers.

Research providers must not directly place orders, make purchases, or change user connector policy. Candidate actions must go through the relevant Agent OS policy and approval gate.

## Initial provider candidates

- `Fincept-Corporation/FinceptTerminal` — terminal-class research, analytics, visual workflows, and data connectors. Treat as license-review-required before bundling or distribution.
- `AI4Finance-Foundation/FinGPT` — finance language-model research candidate.
- `AI4Finance-Foundation/FinNLP` — financial text pipeline candidate.
- `Open-Finance-Lab/AgenticTrading` — financial agent design reference candidate.
- `yya518/FinBERT` — financial sentiment model candidate.

## Fincept posture

Fincept is a strong independent-research candidate because its public README describes multi-asset analytics, AI agents, data connectors, quant modules, and workflow tooling. Do not vendor or redistribute Fincept code until license review is complete. Do not claim a partnership unless separately approved.

## Agent OS flow

```text
research request
  -> provider selection
  -> budget check
  -> cited artifact
  -> redacted receipt
  -> optional candidate action
  -> policy and approval gate
```

## Files

- `repo-intake.v1.json` — initial candidate-provider registry.
- `prompts/codex-fincept-research-provider.md` — Codex implementation prompt for the provider lane.
