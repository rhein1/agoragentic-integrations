# Micro ECF Post-Install Workflow

Micro ECF installs local repo artifacts. It does not create hidden global memory for every future LLM chat.

Micro ECF is a local context wedge and artifact builder. It is not a semantic RAG engine, vector store, hosted answer pipeline, or Full ECF runtime.

Use this checklist after `micro-ecf install --dir . --yes`.

## 1. Verify Generated Files

Confirm these files exist:

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

If they are missing, rerun a read-only plan first:

```bash
micro-ecf plan --dir .
```

Verify the installed boundary:

```bash
micro-ecf doctor --dir .
micro-ecf lint ECF.md
```

Only reinstall after explicit approval:

```bash
micro-ecf install --dir . --yes
```

## 2. Use Micro ECF In New LLM Conversations

Pick the handoff path your IDE or assistant supports.

### Compatible IDE Agents

If the IDE auto-loads repo instruction files, `AGENTS.md` tells the assistant to read:

```text
ECF.md
.micro-ecf/policy-summary.json
.micro-ecf/context-packet.json
.micro-ecf/source-map.json
```

The assistant should say whether it actually read those artifacts in the current conversation.

### Any Other LLM Chat

Paste or attach:

```text
MICRO_ECF_LLM_BOOTSTRAP.md
```

Use this when a new chat does not automatically load repo instructions.

### Persistent MCP Tooling

If your IDE supports local MCP servers, run:

```bash
micro-ecf serve-mcp --root .micro-ecf
```

Then configure that command as a persistent local MCP server in the IDE. This gives future chats a local Micro ECF tool surface instead of relying only on pasted instructions.

## 3. Ask For Source-Status Disclosure

At the start of important work, ask:

```text
Are you using Micro ECF in this conversation?
```

A good assistant should answer one of:

- Yes: it read the Micro ECF artifacts or used the Micro ECF MCP server.
- Partially: it used Micro ECF artifacts plus direct repo reads for source-of-truth verification.
- No: it has not read Micro ECF artifacts and has not used a Micro ECF MCP server.

## 4. Refresh After Meaningful Repo Changes

When docs, source files, schemas, or local DB summaries change, refresh the artifacts:

```bash
micro-ecf scan --dir .
micro-ecf index . --output-dir .micro-ecf
micro-ecf build-packet --policy .micro-ecf/policy.json --source-map .micro-ecf/source-map.json --output-dir .micro-ecf
micro-ecf export --agent-os --policy .micro-ecf/policy.json --output .micro-ecf/harness-export.json
```

For large repos, index a bounded folder instead of the whole repo:

```bash
micro-ecf index ./docs --output-dir .micro-ecf
micro-ecf index ./src --output-dir .micro-ecf
```

## 5. Preview In Agent OS Only When Ready

The harness export is no-spend and non-provisioning:

```bash
AGORAGENTIC_API_KEY=amk_your_key npx agoragentic-os@latest deploy readiness --file .micro-ecf/harness-export.json
AGORAGENTIC_API_KEY=amk_your_key npx agoragentic-os@latest deploy preview --file .micro-ecf/harness-export.json
AGORAGENTIC_API_KEY=amk_your_key npx agoragentic-os@latest deploy create --file .micro-ecf/harness-export.json
```

Use `readiness` and `preview` for no-spend checks. Use `deploy create` only when the owner is ready to record a hosted deployment request. Runtime provisioning, funding, public API exposure, marketplace selling, and x402 monetization remain separate gated steps.

## 6. Keep The Boundary Clear

Micro ECF is local-first and open-source. It can prepare source maps, context packets, policy summaries, and Agent OS Harness exports.

It can also describe external context providers such as RAG, code graphs, database tools, or MCP servers, but those providers bring their own retrieval engines. Micro ECF governs what they may expose or act on.

Micro ECF does not include:

- semantic/vector retrieval
- hosted RAG answering
- embeddings or model-backed reranking
- Full ECF private runtime
- tenant isolation runtime
- enterprise connector internals
- enterprise audit-log internals
- router ranking
- trust or fraud scoring internals
- wallet settlement
- x402 settlement
- hosted provisioning
- private connectors
- secrets broker
- operator prompts

Full ECF and hosted Agent OS internals stay private.
