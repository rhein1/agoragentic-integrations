# Install Micro ECF With An IDE LLM

Paste this GitHub link into the LLM inside your IDE:

```text
https://github.com/rhein1/agoragentic-integrations/tree/main/micro-ecf
```

Then give it this instruction:

```text
Install Micro ECF locally for this project, but do not write files yet.

First, explain in plain English:
- what Micro ECF is
- what it will do locally
- what files it may create
- what it will not do
- why it helps my coding agent or database agent

Then run a read-only plan:

npx agoragentic-micro-ecf@latest plan --dir .

Show me the plan. Do not run install with --yes until I explicitly approve.

After I approve, run:

npx agoragentic-micro-ecf@latest install --dir . --yes

After install, summarize the generated files and tell me how to use .micro-ecf/context-packet.json, .micro-ecf/policy-summary.json, and .micro-ecf/harness-export.json.

Then point me to micro-ecf/POST_INSTALL.md for the future-conversation and refresh workflow.
```

## What The LLM Should Tell The Developer

Micro ECF is a lightweight local context layer for builders who want safer agents. It builds local source maps, policy summaries, and citation-ready context packets from bounded repo/docs/database-summary inputs, applies local policy boundaries, and exports an Agent OS Harness file for deployment preview.

It helps because the LLM gets a stable, local map of what it can safely know, cite, and use. It also creates policy artifacts that make the boundary explicit before the agent touches tools, data, money, or hosted deployment.

Micro ECF also creates `ECF.md`, a persistent agent-readable contract with machine-readable front matter and human-readable policy rationale. New chats should read `ECF.md` before relying on `.micro-ecf/*` artifacts.

Micro ECF is not a semantic RAG engine, vector store, hosted answer pipeline, or Full ECF runtime. If the developer already has RAG, GitNexus, database tools, or MCP context providers, Micro ECF wraps those providers with policy, provenance, budget, and action-risk boundaries.

## Consent Gate

The safe installer is intentionally two-step:

```bash
micro-ecf plan --dir .
micro-ecf install --dir . --yes
```

When the package is not installed globally, use the `npx agoragentic-micro-ecf@latest ...` form. `plan` is read-only.

`install` without `--yes` refuses to write files and returns the same approval plan.

`install --yes` creates local artifacts only:

```text
ECF.md
AGENTS.md
MICRO_ECF_LLM_BOOTSTRAP.md
.micro-ecf/policy.json
.micro-ecf/source-map.json
.micro-ecf/context-packet.json
.micro-ecf/policy-summary.json
.micro-ecf/deployment-preview.json
.micro-ecf/harness-export.json
```

## Future Conversations

Micro ECF is persistent in the repo, not automatically persistent inside every new LLM chat.

Use these rules:

- If the IDE assistant auto-loads repo instructions, `AGENTS.md` should tell it to read the Micro ECF artifacts at the start of non-trivial work.
- If the new chat does not auto-load repo instructions, paste or attach `MICRO_ECF_LLM_BOOTSTRAP.md` at the start of the conversation and tell it to read `ECF.md`.
- If the IDE supports persistent MCP servers, configure `micro-ecf serve-mcp --root .micro-ecf` once so the assistant can query Micro ECF as a local tool.
- The assistant should answer clearly whether it read Micro ECF artifacts, used direct repo reads, used MCP, or did not use Micro ECF in that conversation.

See [`POST_INSTALL.md`](./POST_INSTALL.md) for the complete post-install workflow.

## What It Will Not Do

Micro ECF will not:

- perform semantic/vector retrieval
- generate model answers
- act as a hosted RAG endpoint
- deploy to cloud
- activate billing
- publish a marketplace listing
- call hosted providers
- move wallet funds
- settle x402 payments
- expose Full ECF internals
- expose router ranking, trust scoring, fraud scoring, operator prompts, or enterprise governance internals
- export raw secrets

## Recommended LLM Behavior

The LLM should stop after `plan` and ask:

```text
I can install Micro ECF locally now. This will create AGENTS.md and .micro-ecf/* artifacts only. It will not deploy, spend, publish, provision, or call Agoragentic Cloud. Do you approve?
```

Only after approval should it run:

```bash
micro-ecf install --dir . --yes
```

After install, it should verify:

```bash
micro-ecf doctor --dir .
micro-ecf scan --dir .
micro-ecf lint ECF.md
```
