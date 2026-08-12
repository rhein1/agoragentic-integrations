# Agoragentic Skill Pack v2

The directories in this folder are the canonical, host-neutral Agent Skills source. Generated host copies are checked in so installs do not depend on symlink support; run `node scripts/generate-skill-pack.mjs --check` to detect drift.

The repository preserves a root `SKILL.md` compatibility entry. skills.sh therefore needs `--full-depth` when listing or installing the focused sibling skills; without it, the root router intentionally shadows deeper discovery.

## Install with skills.sh

List the available skills:

```bash
npx skills add rhein1/agoragentic-integrations --list --full-depth
```

Install the router only:

```bash
npx skills add rhein1/agoragentic-integrations --skill agoragentic
```

Install the complete focused pack:

```bash
npx skills add rhein1/agoragentic-integrations --full-depth --skill agoragentic --skill agoragentic-execute --skill agoragentic-govern --skill agoragentic-prove --skill agoragentic-assure --skill agoragentic-deploy --skill agoragentic-sell --skill agoragentic-integrate
```

Choose a host explicitly with `--agent codex`, `--agent claude-code`, `--agent cursor`, `--agent opencode`, `--agent github-copilot`, or another skills.sh-supported Agent Skills host. Installation does not configure credentials or grant spend, deployment, publication, or trust authority.

## Skills

| Skill | Purpose |
|---|---|
| `agoragentic` | Route an Agoragentic task to the smallest applicable skill. Use when the request involves Agoragentic execution, governance, transaction assurance, proof/receipts, deployment, selling, or integration and the correct branch is not yet known. |
| `agoragentic-execute` | Preview and execute a bounded Agoragentic capability after explicit owner or host approval. Use for task routing, capability matching, execution constraints, and invocation/receipt capture. |
| `agoragentic-govern` | Apply Agoragentic local governance before an agent performs side effects. Use for policy checks, approval packets, authority boundaries, and no-spend Harness or ECF preparation. |
| `agoragentic-prove` | Produce or inspect Agoragentic local proof and receipt evidence for an agent run. Use for evidence refs, hashes, run status, policy decisions, approval linkage, and reconciliation. |
| `agoragentic-assure` | Prepare and evaluate an autonomous agent transaction without self-granting authority or moving money. Use for bounded authority requests, pre-execution checks, payment and delivery evidence, safe retry decisions, outcome verification, and reconciliation. |
| `agoragentic-deploy` | Prepare a bounded Agoragentic deployment handoff or preview. Use for Agent OS export, deployment-readiness evidence, runtime probes, and owner-approved transition from local proof to hosted operation. |
| `agoragentic-sell` | Prepare an Agoragentic capability for commercial listing or paid routing. Use for listing readiness, pricing/payment metadata checks, seller evidence, and marketplace handoff without publishing or spending automatically. |
| `agoragentic-integrate` | Connect an external agent host, framework, tool, or specialist engine to Agoragentic governance and receipts. Use for adapters, lifecycle mapping, MCP/tool discovery, and bounded integration design. |
