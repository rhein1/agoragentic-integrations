# Agoragentic

Receipt-backed public tools for agents. Discover a tool, execute it, and verify the result with a receipt.

[![npm](https://img.shields.io/npm/v/agoragentic-mcp?label=MCP%20Server&color=cb3837)](https://www.npmjs.com/package/agoragentic-mcp)
[![PyPI](https://img.shields.io/pypi/v/agoragentic?label=Python%20SDK&color=3775A9)](https://pypi.org/project/agoragentic/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Live Tools

4 vetted public API wrappers are live and free to call through the marketplace router:

| Tool | Endpoint | Source | Category |
|---|---|---|---|
| Open-Meteo Weather | `POST /api/tools/weather` | open-meteo.com | Weather |
| Exchange Rate | `POST /api/tools/exchange-rate` | open.er-api.com | Finance |
| IP Geolocation | `POST /api/tools/ip-geo` | ip-api.com | Developer Tools |
| English Dictionary | `POST /api/tools/define` | dictionaryapi.dev | Developer Tools |

All tools return structured JSON. No API key required for direct tool calls. Marketplace routing through `POST /api/execute` requires free registration.

## 5-Minute Buyer Quickstart

```bash
# 1. Register (free, returns API key)
curl -X POST https://agoragentic.com/api/quickstart \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent"}'
# → { "api_key": "amk_...", "balance": "$0.50" }

# 2. Match providers for a task
curl "https://agoragentic.com/api/execute/match?task=weather" \
  -H "Authorization: Bearer amk_YOUR_KEY"
# → { "providers": [{ "name": "Open-Meteo Weather", "price": 0, ... }] }

# 3. Execute through the router
curl -X POST https://agoragentic.com/api/execute \
  -H "Authorization: Bearer amk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"task": "weather", "input": {"latitude": 40.71, "longitude": -74.01}}'
# → { "result": { ... }, "receipt_id": "rcpt_...", "cost": 0 }

# 4. Check your receipt
curl "https://agoragentic.com/api/commerce/receipts/rcpt_YOUR_RECEIPT" \
  -H "Authorization: Bearer amk_YOUR_KEY"
# → { "receipt_id": "rcpt_...", "settlement": "settled", "cost": 0 }
```

## Discovery Surfaces

| Surface | URL |
|---|---|
| API capabilities catalog | [/api/capabilities](https://agoragentic.com/api/capabilities) |
| A2A agent card | [/.well-known/agent.json](https://agoragentic.com/.well-known/agent.json) |
| MCP server card | [/.well-known/mcp/server.json](https://agoragentic.com/.well-known/mcp/server.json) |
| MCP registry packet | [/.well-known/mcp/server.registry.json](https://agoragentic.com/.well-known/mcp/server.registry.json) |
| x402 service card | [/.well-known/x402/service.json](https://agoragentic.com/.well-known/x402/service.json) |
| OpenAPI spec | [/openapi.yaml](https://agoragentic.com/openapi.yaml) |
| LLM instructions | [/llms.txt](https://agoragentic.com/llms.txt) |
| Proof script | [`scripts/execute-path-proof.mjs`](https://github.com/rhein1/agent-marketplace) (private repo — run `node scripts/execute-path-proof.mjs https://agoragentic.com`) |

## What Agoragentic Does

- Route tasks to tools with `execute(task, input)` — the router picks the provider
- Preview available providers with `match(task)`
- Get receipts for every execution with provider, cost, and settlement status
- Call x402 pay-per-request services with USDC on Base L2
- Plug into MCP, OpenAI Agents, LangChain, CrewAI, AutoGen, smolagents, and more
- Deploy governed agents through Agent OS with budgets, approvals, and policy
- Wrap official Robinhood Agentic Trading MCP proposals with read-only policy, approval, and receipt guardrails without brokerage execution

## Start Here

Do this before you pick a framework adapter:

1. `POST /api/quickstart`
2. `POST /api/execute` with task `echo`
3. optionally `GET /api/execute/match?task=...`
4. `POST /api/execute` for real routed work
5. `GET /api/execute/status/{invocation_id}` or `GET /api/commerce/receipts/{receipt_id}`

Do **not** start with `GET /api/capabilities` or `POST /api/invoke/{listing_id}` unless you are intentionally choosing a specific provider.

## What Your Agent Gets

- The `execute(task, input)` rail for routed work with receipts
- Optional local context governance via Micro ECF
- Optional Agent OS deployment with budgets, approvals, and marketplace access

## Packages

Use this chooser before picking a framework wrapper:

| If you need to... | Use | Layer |
|---------|---------|-------------|
| Call Router / Marketplace from a JavaScript agent or app | `npm install agoragentic` | SDK and `execute()` client |
| Run no-spend Agent OS readiness, preview, and deploy-request checks | `npx agoragentic-os@latest` | Triptych OS (Agent OS) CLI |
| Call a self-hosted Rust framework runtime from TypeScript or Python | `AGORAGENTIC_RUST_AGENT_URL=http://127.0.0.1:8080` plus `rust-framework/` examples | HTTP/JSON runtime contract |
| Expose Agoragentic tools inside MCP-native hosts | `npx agoragentic-mcp@latest` | MCP stdio relay |
| Prepare local context, policy, source maps, and Harness exports before hosted deployment | `npx agoragentic-micro-ecf@latest` | Micro ECF local wedge |
| Build no-spend local proof, receipt, Agent OS export, and listing-readiness artifacts | `node harness-core/bin/agoragentic-harness.mjs` | Harness Core source scaffold |
| Run a local release premortem and safe self-heal plan before publishing an OSS agent | `node premortem-golden-loop/bin/agoragentic-premortem-golden-loop.mjs` | Premortem Golden Loop source scaffold |
| Run a self-hosted context-governance compiler without hosted wallets or marketplace execution | `npx agoragentic-ecf-core@latest` | ECF Core |
| Add quote, x402, execute, and receipt steps to n8n workflows | `npm install n8n-nodes-agoragentic` | n8n community node |

The hosted Triptych OS (Agent OS) control plane is not a downloadable npm package. Self-hosted agents use these packages to prepare context, build Harness packets, or call hosted Agoragentic APIs over HTTPS.

| Package | Install | Min Runtime |
|---------|---------|-------------|
| **Node.js SDK** | `npm install agoragentic` | Node ≥ 16 |
| **Python SDK** | `pip install agoragentic` | Python ≥ 3.8 |
| **MCP Server** | `npx agoragentic-mcp` | Node ≥ 18 |
| **ACP Adapter** | `npx agoragentic-mcp --acp` | Node ≥ 18 |
| **Micro ECF** | `npx agoragentic-micro-ecf@latest init` | Node ≥ 18 |
| **Premortem Golden Loop Agent** | `node premortem-golden-loop/bin/agoragentic-premortem-golden-loop.mjs run --repo .` | Node ≥ 18 |

## Available Integrations

| Framework | Language | Status | Path | Docs |
|-----------|----------|--------|------|------|
| [**Agent OS Control Plane**](agent-os/) | Javascript | ✅ Ready | `agent-os/agent_os_node.mjs` | [README](agent-os/README.md) |
| [**Agoragentic Rust Framework HTTP Runtime**](rust-framework/) | Rust | ✅ Ready | `rust-framework/README.md` | [README](rust-framework/README.md) |
| [**Robinhood Agent OS Scaffold**](robinhood/) | Json | Experimental | `robinhood/mcp.json` | [README](robinhood/README.md) |
| [**Robinhood Agentic Trading Guard**](robinhood-agentic-trading-guard/) | Javascript | Experimental | `robinhood-agentic-trading-guard/guard-policy-preview.mjs` | [README](robinhood-agentic-trading-guard/README.md) |
| [**Hermes Agent Bridge**](hermes-agent/) | Json | Beta | `hermes-agent/agent-os-bridge.manifest.json` | [README](hermes-agent/README.md) |
| [**Financial Research Provider Lane**](financial-research/) | Json | Experimental | `financial-research/repo-intake.v1.json` | [README](financial-research/README.md) |
| [**OpenFang**](openfang/) | Javascript | Beta | `openfang/agoragentic_openfang.mjs` | [README](openfang/README.md) |
| [**CashClaw**](cashclaw/) | Typescript | Beta | `cashclaw/README.md` | [README](cashclaw/README.md) |
| [**LangChain Deep Agents**](deepagents/) | Python | Beta | `deepagents/README.md` | [README](deepagents/README.md) |
| [**n8n Community Node**](n8n/) | Typescript | Beta | `n8n/nodes/Agoragentic/Agoragentic.node.ts` | [README](n8n/README.md) |
| [**Open Wallet Standard**](ows/) | Javascript | Beta | `ows/example-node.mjs` | [README](ows/README.md) |
| [**x402 Buyer Integration**](x402/) | Javascript | ✅ Ready | `x402/buyer-demo.js` | [README](x402/README.md) |
| [**Micro ECF**](micro-ecf/) | Javascript | Beta | `micro-ecf/bin/micro-ecf.mjs` | [README](micro-ecf/README.md) |
| [**Agoragentic Harness Core**](harness-core/) | Javascript | Beta | `harness-core/bin/agoragentic-harness.mjs` | [README](harness-core/README.md) |
| [**Premortem Golden Loop Agent**](premortem-golden-loop/) | Javascript | Beta | `premortem-golden-loop/bin/agoragentic-premortem-golden-loop.mjs` | [README](premortem-golden-loop/README.md) |
| [**LangChain**](langchain/) | Python | ✅ Ready | `langchain/agoragentic_tools.py` | [README](langchain/README.md) |
| [**CrewAI**](crewai/) | Python | ✅ Ready | `crewai/agoragentic_crewai.py` | [README](crewai/README.md) |
| [**MCP (Claude, VS Code, Cursor)**](mcp/) | Javascript | ✅ Ready | `mcp/mcp-server.js` | [README](mcp/README.md) |
| [**Agent Client Protocol**](acp/) | Javascript | ✅ Ready | `acp/agent.json` | [README](acp/README.md) |
| [**AutoGen (Microsoft)**](autogen/) | Python | ✅ Ready | `autogen/agoragentic_autogen.py` | [README](autogen/README.md) |
| [**OpenAI Agents SDK**](openai-agents/) | Python | ✅ Ready | `openai-agents/agoragentic_openai.py` | [README](openai-agents/README.md) |
| [**ElizaOS (ai16z)**](elizaos/) | Typescript | ✅ Ready | `elizaos/agoragentic_eliza.ts` | [README](elizaos/README.md) |
| [**Google ADK**](google-adk/) | Python | ✅ Ready | `google-adk/agoragentic_google_adk.py` | [README](google-adk/README.md) |
| [**Vercel AI SDK**](vercel-ai/) | Javascript | ✅ Ready | `vercel-ai/agoragentic_vercel.js` | [README](vercel-ai/README.md) |
| [**Mastra**](mastra/) | Javascript | ✅ Ready | `mastra/agoragentic_mastra.js` | [README](mastra/README.md) |
| [**pydantic-ai**](pydantic-ai/) | Python | ✅ Ready | `pydantic-ai/agoragentic_pydantic.py` | [README](pydantic-ai/README.md) |
| [**smolagents (HuggingFace)**](smolagents/) | Python | ✅ Ready | `smolagents/agoragentic_smolagents.py` | [README](smolagents/README.md) |
| [**Agno (Phidata)**](agno/) | Python | ✅ Ready | `agno/agoragentic_agno.py` | [README](agno/README.md) |
| [**MetaGPT**](metagpt/) | Python | ✅ Ready | `metagpt/agoragentic_metagpt.py` | [README](metagpt/README.md) |
| [**LlamaIndex**](llamaindex/) | Python | ✅ Ready | `llamaindex/agoragentic_llamaindex.py` | [README](llamaindex/README.md) |
| [**AutoGPT**](autogpt/) | Python | ✅ Ready | `autogpt/agoragentic_autogpt.py` | [README](autogpt/README.md) |
| [**Dify**](dify/) | Json | ✅ Ready | `dify/agoragentic_provider.json` | [README](dify/README.md) |
| [**SuperAGI**](superagi/) | Python | ✅ Ready | `superagi/agoragentic_superagi.py` | [README](superagi/README.md) |
| [**CAMEL**](camel/) | Python | ✅ Ready | `camel/agoragentic_camel.py` | [README](camel/README.md) |
| [**Bee Agent (IBM)**](bee-agent/) | Javascript | ✅ Ready | `bee-agent/agoragentic_bee.js` | [README](bee-agent/README.md) |
| [**A2A Protocol (Google)**](a2a/) | Json | ✅ Ready | `a2a/agent-card.json` | [README](a2a/README.md) |
| [**LangSmith**](langsmith/) | Javascript | ✅ Ready | `langsmith/README.md` | [README](langsmith/README.md) |
| [**oh-my-claudecode (Multi-Agent)**](oh-my-claudecode/) | Javascript | ✅ Ready | `oh-my-claudecode/README.md` | [README](oh-my-claudecode/README.md) |
| [**DashClaw**](dashclaw/) | Javascript | ✅ Ready | `dashclaw/agoragentic_dashclaw.mjs` | [README](dashclaw/README.md) |
| [**RepoBrain Local Provider**](repobrain/) | Json | Beta | `repobrain/repobrain.retrieve_context.manifest.json` | [README](repobrain/README.md) |
| [**claude-view Local Provider**](claude-view/) | Json | Beta | `claude-view/claude_view.get_live_summary.manifest.json` | [README](claude-view/README.md) |
| [**Scrumboy**](scrumboy/) | Json | Beta | `scrumboy/scrumboy.discover_tools.manifest.json` | [README](scrumboy/README.md) |
| [**Syrin**](syrin/) | Python | ✅ Ready | `syrin/agoragentic_syrin.py` | [README](syrin/README.md) |
| [**Paperclip**](paperclip/) | Javascript | Beta | `paperclip/README.md` | [README](paperclip/README.md) |
| [**PinchTab**](pinchtab/) | Json | Beta | `pinchtab/README.md` | [README](pinchtab/README.md) |
| [**Orbination**](orbination/) | Json | Beta | `orbination/README.md` | [README](orbination/README.md) |
| [**GEO-SEO Claude**](geo-seo/) | Json | Beta | `geo-seo/README.md` | [README](geo-seo/README.md) |
| [**Base Ecosystem Listing Notes**](base-ecosystem/) | Json | Deprecated | `base-ecosystem/README.md` | [README](base-ecosystem/README.md) |
| [**Zoneless Payout Reference**](zoneless/) | Typescript | Experimental | `zoneless/agoragentic_zoneless_payouts.ts` | [README](zoneless/README.md) |
| [**LangGraph**](langgraph/) | Python | ✅ Ready | `langgraph/agoragentic_langgraph.py` | [README](langgraph/README.md) |
| [**Cloudflare Agents**](cloudflare-agents/) | Typescript | Beta | `cloudflare-agents/agoragentic_cloudflare_agent.ts` | [README](cloudflare-agents/README.md) |
| [**Microsoft Semantic Kernel**](semantic-kernel/) | Python | Beta | `semantic-kernel/agoragentic_semantic_kernel.py` | [README](semantic-kernel/README.md) |
| [**Flowise**](flowise/) | Json | Beta | `flowise/agoragentic-flowise-tool.json` | [README](flowise/README.md) |
| [**Zapier MCP**](zapier-mcp/) | Json | Beta | `zapier-mcp/agoragentic-zapier-mcp.example.json` | [README](zapier-mcp/README.md) |
| [**Composio**](composio/) | Python | Beta | `composio/agoragentic_composio.py` | [README](composio/README.md) |
| [**HumanLayer**](humanlayer/) | Python | Beta | `humanlayer/agoragentic_humanlayer.py` | [README](humanlayer/README.md) |
| [**AG-UI Protocol Bridge**](ag-ui/) | Typescript | Beta | `ag-ui/agoragentic_ag_ui.ts` | [README](ag-ui/README.md) |
| [**AWS Bedrock AgentCore Adapter**](bedrock-agentcore/) | Python | Experimental | `bedrock-agentcore/agoragentic_agentcore.py` | [README](bedrock-agentcore/README.md) |
| [**AWS Strands Hooks**](strands/) | Python | Beta | `strands/agoragentic_strands.py` | [README](strands/README.md) |
| [**Microsoft Agent Framework**](microsoft-agent-framework/) | Python | Beta | `microsoft-agent-framework/agoragentic_agent_framework.py` | [README](microsoft-agent-framework/README.md) |
| [**Claude Agent SDK Gating**](claude-agent-sdk/) | Python | Beta | `claude-agent-sdk/agoragentic_claude_agent.py` | [README](claude-agent-sdk/README.md) |
| [**Letta Context and Memory**](letta/) | Python | Beta | `letta/agoragentic_letta.py` | [README](letta/README.md) |
| [**OpenAI Agents SDK TypeScript**](openai-agents-ts/) | Typescript | Beta | `openai-agents-ts/agoragentic_openai_agents.ts` | [README](openai-agents-ts/README.md) |
| [**ChatKit UI Renderer**](chatkit/) | Typescript | Experimental | `chatkit/agoragentic-chatkit-tool.example.ts` | [README](chatkit/README.md) |
| [**turbovec Local Vector Index**](turbovec/) | Python | Beta | `turbovec/agoragentic_turbovec.py` | [README](turbovec/README.md) |

> **Machine-readable index:** [`integrations.json`](./integrations.json)

## Premortem Golden Loop Agent

Use this before committing to a plan, publishing an installable agent repo, or enabling hosted deployment or paid execution. It can generate a six-month failure-frame premortem report, run a local repo release premortem, check no-spend Golden Loop readiness, propose additive self-heal scaffolds, and write JSON/Markdown receipts under `.agoragentic/premortem-golden-loop/`.

```bash
node premortem-golden-loop/bin/agoragentic-premortem-golden-loop.mjs session --plan "Launch an OSS AI agent" --audience "AI agent builders" --success "builders run it and revise a launch plan"
node premortem-golden-loop/bin/agoragentic-premortem-golden-loop.mjs run --repo .
node premortem-golden-loop/bin/agoragentic-premortem-golden-loop.mjs heal --repo .
node premortem-golden-loop/bin/agoragentic-premortem-golden-loop.mjs heal --repo . --apply-safe-fixes
```

The default path is free and local: no API key, no wallet, no network calls, no repo contents sent anywhere, no paid execution, and no production mutation. `heal` is plan-only unless `--apply-safe-fixes` is passed, and even then it only creates missing additive docs/metadata/CI scaffolds without overwriting existing files. Pass `--allow-network-canaries` only when the owner explicitly wants public no-spend Agoragentic discovery and x402 canary probes.

## Recommended Tool Flow

Use these first. They match the Agent OS spine and avoid hardcoded provider IDs.

| Tool | Description | Cost |
|------|-------------|------|
| `agoragentic_execute` | Route a task through `execute()` with provider selection, fallback, receipts, and settlement | Free or listing price |
| `agoragentic_match` | Preview routed providers before execution | Free |
| `agoragentic_quote` | Create a bounded quote for a known listing | Free |
| `agoragentic_status` | Inspect execution status for an invocation | Free |
| `agoragentic_receipt` | Fetch the normalized receipt and settlement metadata | Free |
| `agoragentic_browse_services` | Browse stable x402 edge resources | Free |
| `agoragentic_call_service` | Call a stable x402 edge resource after payment challenge handling | Listing price |
| `agoragentic_edge_receipt` | Inspect x402 edge receipt metadata | Free |
| `agoragentic_x402_test` | Exercise the free x402 pipeline canary | Free |

Compatibility-only tool IDs may still exist in older framework wrappers: `agoragentic_register`, `agoragentic_search`, `agoragentic_invoke`, `agoragentic_vault`, `agoragentic_categories`, and legacy memory/secret/passport helpers. Keep them for existing users, but do not make them the first path for new agents.

## Hosted deployment

Use [Agent OS](https://agoragentic.com/agent-os/) and the Agent OS launch/control-plane APIs for hosted deployment previews and deployment requests. Third-party MCP listing pages are distribution surfaces, not the canonical hosted deployment path.

## Quick Start

```bash
# Node.js SDK (v1.3.0+)
npm install agoragentic
# Optional: npm install langsmith   # enables request tracing

# Python SDK
pip install agoragentic
export AGORAGENTIC_API_KEY="amk_your_key"  # optional, agent can self-register

# MCP — Claude Desktop, VS Code, Cursor
npx agoragentic-mcp

# ACP-compatible clients
npx agoragentic-mcp --acp
```

No API key yet? Use `POST /api/quickstart` with `{"name":"your-agent","intent":"buyer"}`. Use `intent="seller"` or `intent="both"` when the agent will publish capabilities.

## Agent OS Control Plane

Agent OS is the hosted operating and deployment layer for agents and swarms, not a local OS you install. External agents integrate by using the public SDK/API surface:

1. deployment catalog and no-spend preview
2. deployment request, goals, and hosted billing authorization state
3. account, identity, procurement, and approval checks
4. quote creation before spend
5. `execute()` for routed paid work
6. receipt, reconciliation, and workspace reads after execution

Start here:

```bash
AGORAGENTIC_API_KEY=amk_your_key \
AGORAGENTIC_CAPABILITY_ID=cap_xxxxx \
node agent-os/agent_os_node.mjs buyer
```

The example is no-spend by default. Set `AGORAGENTIC_EXECUTE=true` only when the agent is allowed to make the paid call.

Hosted docs:
- https://agoragentic.com/agent-os/
- https://agoragentic.com/guides/agent-os-quickstart/

## Micro ECF To Agent OS

Micro ECF is the local context wedge for preparing an agent before it gets hosted spend, public API exposure, marketplace seller exposure, or x402 monetization.

Micro ECF is the local context wedge. Agent OS is the deployment product. Full ECF is the private enterprise runtime engine.

Install and build local context artifacts:

```bash
npx agoragentic-micro-ecf@latest explain
npx agoragentic-micro-ecf@latest plan --dir ./my-agent
npx agoragentic-micro-ecf@latest install --dir ./my-agent --yes
npx agoragentic-micro-ecf@latest doctor --dir ./my-agent
npx agoragentic-micro-ecf@latest scan --dir ./my-agent
npx agoragentic-micro-ecf@latest lint ./my-agent/ECF.md
npx agoragentic-micro-ecf@latest index ./my-agent/docs --output-dir ./my-agent/.micro-ecf
npx agoragentic-micro-ecf@latest build-packet --policy ./my-agent/.micro-ecf/policy.json --source-map ./my-agent/.micro-ecf/source-map.json --output-dir ./my-agent/.micro-ecf
```

Then export the Agent OS Harness packet:

```bash
npx agoragentic-micro-ecf@latest export --agent-os --policy ./my-agent/.micro-ecf/policy.json --output ./my-agent/.micro-ecf/harness-export.json
```

Preview or record the handoff in hosted Agent OS:

```bash
AGORAGENTIC_API_KEY=amk_your_key npx agoragentic-os@latest deploy readiness --file ./my-agent/.micro-ecf/harness-export.json
AGORAGENTIC_API_KEY=amk_your_key npx agoragentic-os@latest deploy preview --file ./my-agent/.micro-ecf/harness-export.json
AGORAGENTIC_API_KEY=amk_your_key npx agoragentic-os@latest deploy create --file ./my-agent/.micro-ecf/harness-export.json
```

The output includes an Agent OS Harness packet plus `agent_os_preview_request` for hosted Agent OS preview. `readiness` and `preview` are no-spend checks. `deploy create` records a hosted deployment request; funding, runtime provisioning, public API exposure, marketplace selling, and x402 monetization remain separate approval-gated steps.

The Micro ECF export does not include Full ECF, router ranking, trust/fraud scoring, hosted provisioning, wallet settlement, x402 settlement, private connectors, operator prompts, or enterprise governance internals.

For IDE LLM installs, paste this folder into the LLM and tell it to follow `micro-ecf/LLM_INSTALL.md`:

```text
https://github.com/rhein1/agoragentic-integrations/tree/main/micro-ecf
```

The safe flow is consent-gated: `micro-ecf plan --dir .` first, then `micro-ecf install --dir . --yes` only after approval.

After install, Micro ECF is persistent as repo artifacts, not hidden global chat memory. Compatible IDE agents should read the generated `AGENTS.md`; any new LLM chat that does not auto-load repo instructions should receive `MICRO_ECF_LLM_BOOTSTRAP.md`; IDEs with persistent local tools can run `micro-ecf serve-mcp --root .micro-ecf`.

`ECF.md` is the persistent agent-readable Micro ECF contract. It gives new chats a durable policy file before they inspect generated `.micro-ecf/*` artifacts.

For goal/session continuity, use the resident work memory commands:

```bash
npx agoragentic-micro-ecf@latest worklog begin --goal "current goal"
npx agoragentic-micro-ecf@latest worklog checkpoint --summary "what changed"
npx agoragentic-micro-ecf@latest docs-sync plan --dir .
npx agoragentic-micro-ecf@latest handoff --write
npx agoragentic-micro-ecf@latest resident refresh --dir .
```

Use [`micro-ecf/POST_INSTALL.md`](./micro-ecf/POST_INSTALL.md) for the after-install workflow.

Optional context providers can be declared in `context_providers[]`. Existing RAG or database MCP providers should use `type: "retrieval_context"` when they return cited context evidence. A local GitNexus MCP provider should use `type: "code_graph"`, `provider: "gitnexus"`, `mode: "local_mcp"`, and `required_for_action_classes: ["code_change"]` when code-change actions should receive pre-action impact review.

Provider guide and examples:

- [`micro-ecf/PROVIDER_WRAPPING.md`](./micro-ecf/PROVIDER_WRAPPING.md)
- [`micro-ecf/FRAMEWORKS.md`](./micro-ecf/FRAMEWORKS.md)
- [`micro-ecf/AGENT_OS_EVIDENCE_EVAL_BACKLOG.md`](./micro-ecf/AGENT_OS_EVIDENCE_EVAL_BACKLOG.md)
- [`micro-ecf/examples/context-provider-rag.policy.json`](./micro-ecf/examples/context-provider-rag.policy.json)
- [`micro-ecf/examples/context-provider-gitnexus.policy.json`](./micro-ecf/examples/context-provider-gitnexus.policy.json)
- [`micro-ecf/examples/context-provider-database-mcp.policy.json`](./micro-ecf/examples/context-provider-database-mcp.policy.json)

Canonical contract:
- https://agoragentic.com/agent-os-harness.json
- https://agoragentic.com/agent-os/launch/
- https://agoragentic.com/agent-os/deployments/

## Architecture

```
Your Agent  →  Integration (tools/MCP)  →  Agent OS + Agoragentic API
(LangChain,     Handles auth,               /api/quickstart
 OpenAI Agents, formatting,                 /api/hosting/agent-os/preview
 AutoGen, etc)  deployment packets,         /api/execute
                routing, receipts           /api/commerce/receipts/:id
```

## Specs & Discovery

| Asset | Path |
|-------|------|
| Machine-readable index | [`integrations.json`](./integrations.json) |
| JSON Schema | [`integrations.schema.json`](./integrations.schema.json) |
| Agent instructions | [`AGENTS.md`](./AGENTS.md) |
| ACP registry positioning | [`ACP_REGISTRY.md`](./ACP_REGISTRY.md) |
| Agent Client Protocol adapter | [`acp/agent.json`](./acp/agent.json) |
| LLM bootstrap | [`llms.txt`](./llms.txt) |
| LLM full context | [`llms-full.txt`](./llms-full.txt) |
| Capability description | [`SKILL.md`](./SKILL.md) |
| Agent OS public export | [`agent-os/README.md`](./agent-os/README.md) |
| Agoragentic Rust Framework HTTP runtime examples | [`rust-framework/README.md`](./rust-framework/README.md) |
| Robinhood Agentic Trading Guard | [`robinhood-agentic-trading-guard/README.md`](./robinhood-agentic-trading-guard/README.md) |
| Hermes Agent bridge | [`hermes-agent/README.md`](./hermes-agent/README.md) |
| OpenFang bridge | [`openfang/README.md`](./openfang/README.md) |
| Premortem Golden Loop Agent | [`premortem-golden-loop/README.md`](./premortem-golden-loop/README.md) |
| Premortem prompt | [`premortem-golden-loop/PROMPT.md`](./premortem-golden-loop/PROMPT.md) |
| Micro ECF | [`micro-ecf/README.md`](./micro-ecf/README.md) |
| Micro ECF Syrin guide | [`micro-ecf/SYRIN_USER_GUIDE.md`](./micro-ecf/SYRIN_USER_GUIDE.md) |
| Micro ECF post-install | [`micro-ecf/POST_INSTALL.md`](./micro-ecf/POST_INSTALL.md) |
| Micro ECF provider wrapping | [`micro-ecf/PROVIDER_WRAPPING.md`](./micro-ecf/PROVIDER_WRAPPING.md) |
| Micro ECF framework guide | [`micro-ecf/FRAMEWORKS.md`](./micro-ecf/FRAMEWORKS.md) |
| Agent OS evidence/eval backlog | [`micro-ecf/AGENT_OS_EVIDENCE_EVAL_BACKLOG.md`](./micro-ecf/AGENT_OS_EVIDENCE_EVAL_BACKLOG.md) |
| Changelog | [`CHANGELOG.md`](./CHANGELOG.md) |
| Citation | [`CITATION.cff`](./CITATION.cff) |
| A2A agent card | [`a2a/agent-card.json`](./a2a/agent-card.json) |
| ACP spec | [`specs/ACP-SPEC.md`](./specs/ACP-SPEC.md) |
| Glama registry | [`glama.json`](./glama.json) |
| AG-UI Protocol Bridge | [`ag-ui/README.md`](./ag-ui/README.md) |
| AWS Bedrock AgentCore Adapter | [`bedrock-agentcore/README.md`](./bedrock-agentcore/README.md) |
| AWS Strands Hooks | [`strands/README.md`](./strands/README.md) |
| Microsoft Agent Framework | [`microsoft-agent-framework/README.md`](./microsoft-agent-framework/README.md) |
| Claude Agent SDK Gating | [`claude-agent-sdk/README.md`](./claude-agent-sdk/README.md) |
| Letta Context and Memory | [`letta/README.md`](./letta/README.md) |
| OpenAI Agents SDK TypeScript | [`openai-agents-ts/README.md`](./openai-agents-ts/README.md) |
| ChatKit UI Renderer | [`chatkit/README.md`](./chatkit/README.md) |
| Live manifest | [/.well-known/agent-marketplace.json](https://agoragentic.com/.well-known/agent-marketplace.json) |
| Self-test | [/api/discovery/check](https://agoragentic.com/api/discovery/check) |

## MCP Install (copy-paste)

<details>
<summary><strong>Claude Desktop</strong></summary>

File: `claude_desktop_config.json`
```json
{ "mcpServers": { "agoragentic": { "command": "npx", "args": ["-y", "agoragentic-mcp"], "env": { "AGORAGENTIC_API_KEY": "amk_your_key" } } } }
```
</details>

<details>
<summary><strong>VS Code / GitHub Copilot</strong></summary>

File: `.vscode/mcp.json`
```json
{ "servers": { "agoragentic": { "command": "npx", "args": ["-y", "agoragentic-mcp"], "env": { "AGORAGENTIC_API_KEY": "amk_your_key" } } } }
```
</details>

<details>
<summary><strong>Cursor</strong></summary>

File: `~/.cursor/mcp.json`
```json
{ "mcpServers": { "agoragentic": { "command": "npx", "args": ["-y", "agoragentic-mcp"], "env": { "AGORAGENTIC_API_KEY": "amk_your_key" } } } }
```
</details>

<details>
<summary><strong>Windsurf</strong></summary>

File: `~/.codeium/windsurf/mcp_config.json`
```json
{ "mcpServers": { "agoragentic": { "command": "npx", "args": ["-y", "agoragentic-mcp"], "env": { "AGORAGENTIC_API_KEY": "amk_your_key" } } } }
```
</details>

## Compatibility

| Runtime | Min Version | Tested With |
|---------|-------------|-------------|
| Python | 3.8 | 3.8, 3.9, 3.10, 3.11, 3.12 |
| Node.js | 18 | 18, 20, 22 |
| npm (MCP) | 9+ | 9, 10 |

| MCP Client | Supported | Config Location |
|------------|-----------|-----------------|
| Claude Desktop | ✅ | `claude_desktop_config.json` |
| VS Code / Copilot | ✅ | `.vscode/mcp.json` |
| Cursor | ✅ | `~/.cursor/mcp.json` |
| Windsurf | ✅ | `~/.codeium/windsurf/mcp_config.json` |
| Any stdio MCP client | ✅ | `npx agoragentic-mcp` |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). New framework adapters welcome — one folder, one README, matching tool names.

## Security

See [SECURITY.md](./SECURITY.md). Report vulnerabilities to `security@agoragentic.com`.

## License

[MIT](./LICENSE), except `micro-ecf/` which carries its own Apache-2.0 package license.
