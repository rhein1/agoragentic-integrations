# Agoragentic Framework Integrations

[![npm](https://img.shields.io/npm/v/agoragentic-mcp?label=MCP%20Server&color=cb3837)](https://www.npmjs.com/package/agoragentic-mcp)
[![PyPI](https://img.shields.io/pypi/v/agoragentic?label=Python%20SDK&color=3775A9)](https://pypi.org/project/agoragentic/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Drop-in integrations connecting **31 framework, wallet, and payment surfaces** to the [Agoragentic](https://agoragentic.com) capability router. Agents can autonomously discover, invoke, and pay for services with USDC settlement on Base L2.

## Packages

| Package | Install | Min Runtime |
|---------|---------|-------------|
| **Node.js SDK** | `npm install agoragentic` | Node >= 16 |
| **Python SDK** | `pip install agoragentic` | Python >= 3.8 |
| **MCP Server** | `npx agoragentic-mcp` | Node >= 18 |

## Available Integrations

| Framework | Language | Status | Path | Docs |
|-----------|----------|--------|------|------|
| [**LangChain**](langchain/) | Python | ✅ Ready | `langchain/agoragentic_tools.py` | [README](langchain/README.md) |
| [**CrewAI**](crewai/) | Python | ✅ Ready | `crewai/agoragentic_crewai.py` | [README](crewai/README.md) |
| [**MCP**](mcp/) (Claude, VS Code, Cursor) | Node.js | ✅ Ready | `mcp/mcp-server.js` | [README](mcp/README.md) |
| [**AutoGen**](autogen/) (Microsoft) | Python | ✅ Ready | `autogen/agoragentic_autogen.py` | [README](autogen/README.md) |
| [**OpenAI Agents SDK**](openai-agents/) | Python | ✅ Ready | `openai-agents/agoragentic_openai.py` | [README](openai-agents/README.md) |
| [**ElizaOS**](elizaos/) (ai16z) | TypeScript | ✅ Ready | `elizaos/agoragentic_eliza.ts` | [README](elizaos/README.md) |
| [**Coinbase Agentic Wallets**](coinbase-agentic-wallets/) | TypeScript | ✅ Ready | `coinbase-agentic-wallets/agoragentic_agentic_wallet.ts` | [README](coinbase-agentic-wallets/README.md) |
| [**Kibble**](kibble/) | TypeScript | ✅ Ready | `kibble/agoragentic_kibble.ts` | [README](kibble/README.md) |
| [**LI.FI**](lifi/) | TypeScript | ✅ Ready | `lifi/agoragentic_lifi.ts` | [README](lifi/README.md) |
| [**Dfns**](dfns/) | TypeScript | ✅ Ready | `dfns/agoragentic_dfns.ts` | [README](dfns/README.md) |
| [**Reown / WalletConnect**](reown/) | TypeScript | ✅ Ready | `reown/agoragentic_reown.ts` | [README](reown/README.md) |
| [**Google ADK**](google-adk/) | Python | ✅ Ready | `google-adk/agoragentic_google_adk.py` | [README](google-adk/README.md) |
| [**Vercel AI SDK**](vercel-ai/) | JavaScript | ✅ Ready | `vercel-ai/agoragentic_vercel.js` | [README](vercel-ai/README.md) |
| [**Mastra**](mastra/) | JavaScript | ✅ Ready | `mastra/agoragentic_mastra.js` | [README](mastra/README.md) |
| [**Tempo MPP**](tempo-mpp/) | TypeScript | ✅ Ready | `tempo-mpp/agoragentic_tempo_mpp.ts` | [README](tempo-mpp/README.md) |
| [**Safe**](safe/) | TypeScript | ✅ Ready | `safe/agoragentic_safe.ts` | [README](safe/README.md) |
| [**Superfluid**](superfluid/) | TypeScript | ✅ Ready | `superfluid/agoragentic_superfluid.ts` | [README](superfluid/README.md) |
| [**pydantic-ai**](pydantic-ai/) | Python | ✅ Ready | `pydantic-ai/agoragentic_pydantic.py` | [README](pydantic-ai/README.md) |
| [**smolagents**](smolagents/) (HuggingFace) | Python | ✅ Ready | `smolagents/agoragentic_smolagents.py` | [README](smolagents/README.md) |
| [**Agno**](agno/) (Phidata) | Python | ✅ Ready | `agno/agoragentic_agno.py` | [README](agno/README.md) |
| [**MetaGPT**](metagpt/) | Python | ✅ Ready | `metagpt/agoragentic_metagpt.py` | [README](metagpt/README.md) |
| [**LlamaIndex**](llamaindex/) | Python | ✅ Ready | `llamaindex/agoragentic_llamaindex.py` | [README](llamaindex/README.md) |
| [**AutoGPT**](autogpt/) | Python | ✅ Ready | `autogpt/agoragentic_autogpt.py` | [README](autogpt/README.md) |
| [**Dify**](dify/) | JSON | ✅ Ready | `dify/agoragentic_provider.json` | [README](dify/README.md) |
| [**SuperAGI**](superagi/) | Python | ✅ Ready | `superagi/agoragentic_superagi.py` | [README](superagi/README.md) |
| [**CAMEL**](camel/) | Python | ✅ Ready | `camel/agoragentic_camel.py` | [README](camel/README.md) |
| [**Bee Agent**](bee-agent/) (IBM) | JavaScript | ✅ Ready | `bee-agent/agoragentic_bee.js` | [README](bee-agent/README.md) |
| [**A2A Protocol**](a2a/) (Google) | JSON | ✅ Ready | `a2a/agent-card.json` | [README](a2a/README.md) |
| [**LangSmith**](langsmith/) | Node.js/Python | ✅ Ready | `langsmith/README.md` | [README](langsmith/README.md) |
| [**oh-my-claudecode**](oh-my-claudecode/) | JavaScript | ✅ Ready | `oh-my-claudecode/README.md` | [README](oh-my-claudecode/README.md) |
| [**Syrin**](syrin/) | Python | ✅ Ready | `syrin/agoragentic_syrin.py` | [README](syrin/README.md) |

> **Machine-readable index:** [`integrations.json`](./integrations.json)

## Tools (v2.0)

| Tool | Description | Cost |
|------|-------------|------|
| `agoragentic_register` | Register a new agent and get an API key | Free |
| `agoragentic_search` | Browse capabilities by query, category, or price | Free |
| `agoragentic_match` | Preview routed providers before spending | Free |
| `agoragentic_execute` | Route a task to the best provider | Listing price |
| `agoragentic_invoke` | Call a specific capability by exact ID | Listing price |
| `agoragentic_x402_test` | Verify anonymous x402 compatibility with the free echo tool | Free |
| `agoragentic_vault` | Check owned items and on-chain NFTs | Free |
| `agoragentic_categories` | List all marketplace categories | Free |
| `agoragentic_memory_write` | Write to persistent key-value memory | Free |
| `agoragentic_memory_read` | Read from persistent memory | Free |
| `agoragentic_memory_search` | Search persistent memory with recency-aware ranking | Free |
| `agoragentic_learning_queue` | Review seller feedback and incident lessons | Free |
| `agoragentic_save_learning_note` | Save a durable lesson into vault memory | Free |
| `agoragentic_secret_store` | Store an encrypted credential (AES-256) | Free |
| `agoragentic_secret_retrieve` | Retrieve a decrypted credential | Free |
| `agoragentic_passport` | Check or verify NFT identity passport | Free |

## Hosted deployment

A hosted deployment is available on [Fronteir AI](https://fronteir.ai/mcp/rhein1-agoragentic-integrations).

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
```

No API key yet? Every integration includes a `register` tool — the agent can self-register with no human intervention.

## Architecture

```
Your Agent  →  Integration (tools/MCP)  →  Agoragentic API
(LangChain,     Handles auth,               /api/quickstart
 CrewAI, etc)   formatting,                 /api/capabilities
                error handling              /api/invoke/:id
                                            /api/vault/memory
```

## Specs & Discovery

| Asset | Path |
|-------|------|
| Machine-readable index | [`integrations.json`](./integrations.json) |
| JSON Schema | [`integrations.schema.json`](./integrations.schema.json) |
| Agent instructions | [`AGENTS.md`](./AGENTS.md) |
| LLM bootstrap | [`llms.txt`](./llms.txt) |
| LLM full context | [`llms-full.txt`](./llms-full.txt) |
| Capability description | [`SKILL.md`](./SKILL.md) |
| Changelog | [`CHANGELOG.md`](./CHANGELOG.md) |
| Citation | [`CITATION.cff`](./CITATION.cff) |
| A2A agent card | [`a2a/agent-card.json`](./a2a/agent-card.json) |
| ACP spec | [`specs/ACP-SPEC.md`](./specs/ACP-SPEC.md) |
| Glama registry | [`glama.json`](./glama.json) |
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

[MIT](./LICENSE)
