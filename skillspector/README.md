# SkillSpector + Agoragentic

**Status: Beta**

SkillSpector is a local security scanner for agent skills. Use it as an
admission scan before a skill is listed, installed into a governed agent
workspace, or attached to an Agent OS harness/export packet.

This adapter is a local scan contract only. It does not publish skills, create
trust badges, mutate seller reputation, call hosted providers, or move funds.

## Source Check

| Field | Evidence |
|-------|----------|
| Upstream | `https://github.com/NVIDIA/SkillSpector` |
| License | Apache-2.0 |
| Verified commit | `dde36f258729b5aec7c835295a9556e64a2def0c` |
| Release state | No upstream git tags were present when this adapter was added |

Because no tagged release was present, pin the commit above until upstream
publishes a stable release.

## Install

```bash
pip install git+https://github.com/NVIDIA/SkillSpector.git@dde36f258729b5aec7c835295a9556e64a2def0c
```

## Local Scan

```bash
skillspector-scan --skill-path ./skills/example --output-format json
```

Use the example contract in
[`skillspector.admission.example.json`](./skillspector.admission.example.json)
to normalize a scan into Agoragentic admission evidence.

## Agoragentic Mapping

```text
Candidate skill
  -> local SkillSpector scan
  -> normalized admission evidence packet
  -> existing Agent OS scorecard/canary evidence fields
  -> human or policy decision before listing/install
```

SkillSpector risk output should compose with the existing Agoragentic scorecard
and canary evidence model. Do not create a parallel trust vocabulary or publish
`verified` status from SkillSpector alone.

## Admission Fields

| Field | Meaning |
|-------|---------|
| `scanner` | Scanner name and pinned upstream commit |
| `skill_ref` | Local path, repo, or immutable artifact reference for the scanned skill |
| `risk_score` | Normalized 0-100 score, where higher means riskier |
| `risk_level` | `low`, `medium`, `high`, or `critical` |
| `findings` | Bounded finding summaries safe to store as admission evidence |
| `scorecard_target` | Existing Agoragentic target type the scan should attach to |

## Safety Boundary

- Scan locally; do not upload private skill source unless the owner explicitly
  approves an export.
- Store bounded finding summaries, not full private source files or secrets.
- Treat results as advisory admission evidence until a human or policy gate
  accepts them.
- Keep the runtime trust vocabulary stable: `verified`, `reachable`, `failed`.
- Do not use this adapter to bypass sandbox verification, canary evidence, or
  owner approval.
