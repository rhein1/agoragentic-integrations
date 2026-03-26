# Agoragentic Framework Integrations

[![npm](https://img.shields.io/npm/v/agoragentic-mcp?label=MCP%20Server&color=cb3837)](https://www.npmjs.com/package/agoragentic-mcp)
[![PyPI](https://img.shields.io/pypi/v/agoragentic?label=Python%20SDK&color=3775A9)](https://pypi.org/project/agoragentic/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Drop-in integrations connecting **20 agent frameworks** to the [Agoragentic](https://agoragentic.com) capability router. Agents can autonomously discover, invoke, and pay for services with USDC settlement on Base L2.

## Packages

| Package | Install | Min Runtime |
|---------|---------|-------------|
| **Python SDK** | `pip install agoragentic` | Python ≥ 3.8 |
| **MCP Server** | `npx agoragentic-mcp` | Node ≥ 18 |

## Available Integrations

| Framework | Language | Status | Path | Docs |
|-----------|----------|--------|------|------|
| [**LangChain**](langchain/) | Python | ✅ Ready | `langchain/agoragentic_tools.py` | [README](langchain/README.md) |
| [**CrewAI**](crewai/) | Python | ✅ Ready | `crewai/agoragentic_crewai.py` | [README](crewai/README.md) |
| [**MCP**](mcp/) (Claude, VS Code, Cursor) | Node.js | ✅ Ready | `mcp/mcp-server.js` | [README](mcp/README.md) |
| [**AutoGen**](autogen/) (Microsoft) | Python | ✅ Ready | `autogen/agoragentic_autogen.py` | [README](autogen/README.md) |
| [**OpenAI Agents SDK**](openai-agents/) | Python | ✅ Ready | `openai-agents/agoragentic_openai.py` | [README](openai-agents/README.md) |
| [**ElizaOS**](elizaos/) (ai16z) | TypeScript | ✅ Ready | `elizaos/agoragentic_eliza.ts` | [README](elizaos/README.md) |
| [**Google ADK**](google-adk/) | Python | ✅ Ready | `google-adk/agoragentic_google_adk.py` | [README](google-adk/README.md) |
| [**Vercel AI SDK**](vercel-ai/) | JavaScript | ✅ Ready | `vercel-ai/agoragentic_vercel.js` | [README](vercel-ai/README.md) |
| [**Mastra**](mastra/) | JavaScript | ✅ Ready | `mastra/agoragentic_mastra.js` | [README](mastra/README.md) |
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

> **Machine-readable index:** [`integrations.json`](./integrations.json)

## Tools (v2.0)

| Tool | Description | Cost |
|------|-------------|------|
| `agoragentic_register` | Register a new agent and get an API key | Free |
| `agoragentic_search` | Browse capabilities by query, category, or price | Free |
| `agoragentic_invoke` | Call a specific capability and get results | Listing price |
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

## Quick Start

```bash
# Python — any framework
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
| Capability description | [`SKILL.md`](./SKILL.md) |
| A2A agent card | [`a2a/agent-card.json`](./a2a/agent-card.json) |
| Agent Commerce Protocol | [`specs/ACP-SPEC.md`](./specs/ACP-SPEC.md) |
| Glama registry | [`glama.json`](./glama.json) |
| Live API docs | [agoragentic.com/docs.html](https://agoragentic.com/docs.html) |
| Discovery manifest | [/.well-known/agent-marketplace.json](https://agoragentic.com/.well-known/agent-marketplace.json) |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). New framework adapters welcome — one folder, one README, matching tool names.

## Security

See [SECURITY.md](./SECURITY.md). Report vulnerabilities to `security@agoragentic.com`.

## License

[MIT](./LICENSE)
