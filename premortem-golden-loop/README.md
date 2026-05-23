# Agoragentic Premortem Golden Loop Agent

OSS premortem agent for plans, launches, products, hires, strategies, and installable AI agent repositories. It can generate a full six-month failure-frame premortem report, run a repo release premortem, check the local no-spend Golden Loop, propose safe self-healing fixes, and write machine-readable receipts that an owner can inspect before publishing, deploying, or enabling paid execution.

This package is local-first by default:

- free to use
- no Agoragentic API key required
- no wallet required
- no repo contents, prompts, business plans, reports, or receipts sent anywhere
- no network calls unless explicitly requested
- no paid execution
- no production mutation
- self-heal never overwrites existing files, deletes files, rotates secrets, deploys, or publishes

## Install

From this repository:

```bash
cd premortem-golden-loop
npm test
node bin/agoragentic-premortem-golden-loop.mjs run --repo ../my-agent --skip-network
```

When published as a package:

```bash
npx agoragentic-premortem-golden-loop run --repo .
```

## Commands

```bash
# Full Klein-style premortem session for a plan, launch, or decision.
node bin/agoragentic-premortem-golden-loop.mjs session \
  --plan "Launch an OSS AI agent that runs premortems and Golden Loop readiness checks" \
  --audience "AI agent builders preparing public releases" \
  --success "builders install it, run it, and make one concrete launch change"

# Full local premortem plus no-spend Golden Loop receipt.
node bin/agoragentic-premortem-golden-loop.mjs run --repo .

# Self-heal plan only. No files are changed.
node bin/agoragentic-premortem-golden-loop.mjs heal --repo .

# Apply safe additive fixes: missing docs, agent.json, .env.example, or CI scaffold.
node bin/agoragentic-premortem-golden-loop.mjs heal --repo . --apply-safe-fixes

# Static repo release premortem only.
node bin/agoragentic-premortem-golden-loop.mjs premortem --repo .

# Golden Loop readiness only.
node bin/agoragentic-premortem-golden-loop.mjs golden-loop --repo .

# CI mode: fail when blockers or Golden Loop failures remain.
node bin/agoragentic-premortem-golden-loop.mjs run --repo . --ci

# Explicit offline mode. This is also the default.
node bin/agoragentic-premortem-golden-loop.mjs run --repo . --skip-network

# Optional public no-spend canaries. Sends no repo contents.
node bin/agoragentic-premortem-golden-loop.mjs run --repo . --allow-network-canaries

# Optional runtime probe for a locally running agent.
node bin/agoragentic-premortem-golden-loop.mjs run --repo . --target-url http://localhost:3000
```

Artifacts are written to:

```text
.agoragentic/premortem-golden-loop/
  premortem-report-[timestamp].html
  premortem-transcript-[timestamp].md
  premortem-session-[timestamp].json
  premortem.json
  premortem.md
  golden-loop.json
  golden-loop.md
  local-receipt.json
  summary.md
  healing-plan.json
  healing-plan.md
  healing-recheck.json
```

## Workflow For Users

1. Run `session` on the business plan, launch, product, hire, or strategy so the agent can expose how it could fail.
2. Run `run --repo .` on the installable repo to audit the Golden Loop readiness path locally.
3. Run `heal --repo .` to see the safe self-healing plan without changing files.
4. Run `heal --repo . --apply-safe-fixes` only after reviewing the plan.
5. Rerun `run --repo . --ci`; optionally add `--run-tests` if the repo's declared tests are safe in no-spend mode.
6. Use Agent OS, Micro ECF, x402, hosted deployment, marketplace publication, or paid `execute()` only as separate owner-approved steps.

## Premortem Session Workflow

The `session` command implements the prompt in [`PROMPT.md`](./PROMPT.md):

- checks whether it has the minimum context: what it is, who it is for, and what success looks like
- frames the plan as already failed six months from now
- generates the raw failure reasons
- runs one independent investigator pass per failure reason
- synthesizes the most likely failure, most dangerous failure, hidden assumption, revised plan, and pre-launch checklist
- writes a self-contained dark HTML report and a full Markdown transcript

If context is missing, it writes `premortem-context-needed.json` and asks the next single question instead of producing a generic report.

## What The Premortem Checks

The premortem looks for release blockers and operating risks:

- README, OSS license, and reproducible install contract
- declared test contract
- agent discovery metadata such as `agent.json`, `agent-card.json`, `SKILL.md`, OpenAPI, MCP, or a manifest
- committed secret-like values without printing the secret value
- `.env.example` or equivalent configuration instructions
- explicit no-spend, budget, owner approval, x402, USDC, or paid-execution boundaries
- receipt, trace, invocation, reconciliation, or audit-proof contract
- basic runtime operations notes such as health, readiness, rollback, or runbook
- Agent OS / Micro ECF / `execute(task,input,constraints)` alignment when the repo is meant to launch through Agoragentic

## What The No-Spend Golden Loop Tests

The local Golden Loop is a readiness loop, not a settlement proof:

1. install contract exists
2. configuration and secret boundary is clear
3. agent discovery contract exists
4. premortem blockers are resolved
5. receipt/proof contract exists
6. owner approval and spend boundary is explicit
7. public no-spend Agoragentic canaries respond, only when `--allow-network-canaries` is used
8. optional target runtime responds, when `--target-url` is provided
9. optional declared tests pass, when `--run-tests` is used

The public canaries are off by default. If enabled, they use only unauthenticated no-spend surfaces and do not send repository contents:

- `GET /api/discovery/check`
- `GET /api/x402/info`
- `GET /api/x402/test/echo`
- `GET /api/catalog?spend_possible=false&auth=none`

## Self-Healing Boundaries

The `heal` command is deliberately conservative. In plan mode it writes only `healing-plan.json` and `healing-plan.md` under `.agoragentic/premortem-golden-loop/`.

With `--apply-safe-fixes`, it may create only missing additive scaffolds:

- `docs/AGORAGENTIC_GOALS.md`
- `docs/AGORAGENTIC_WORKFLOWS.md`
- `docs/AGORAGENTIC_SAFETY_BOUNDARIES.md`
- `agent.json`
- `.env.example`
- `.github/workflows/agoragentic-premortem-golden-loop.yml`

It does not overwrite existing files, edit application source code, delete files, remove secrets, rotate credentials, install dependencies, call paid `execute()`, transfer USDC, publish listings, deploy, or open a production runtime. Secret findings and license choices remain manual owner actions.

## Paid Proof Boundary

This package intentionally does not sign wallet payments or run paid `execute()` calls. Real Golden Loop proof on Agoragentic includes wallet ownership, funding, quote-backed execution, receipt, and reconciliation. That path must remain explicitly owner-approved and budget-gated.

For integrations, keep external paid work routed through:

```text
execute(task, input, constraints)
```

Do not hardcode provider IDs unless the agent intentionally needs a specific provider.
