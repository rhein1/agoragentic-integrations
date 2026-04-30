# Using Micro ECF With Existing Agent Frameworks

Micro ECF does not replace your agent framework.

Use it as the local context and policy boundary around agents built with frameworks such as OpenHands, CrewAI, LangGraph, Letta, browser-use, GPT Researcher, OpenAI Agents SDK, AutoGen, Syrin, Codex, Cursor, Claude, Gemini, or any MCP-compatible IDE agent.

## The Pattern

```text
your agent framework
-> local repo/docs/db/tools
-> Micro ECF context and policy boundary
-> Agent OS harness export
-> Agent OS readiness / preview / deployment request
```

Micro ECF answers:

```text
What may this agent read, cite, use, package, and export?
```

Your framework still owns:

```text
planning
tool use
memory implementation
browser automation
coding actions
research workflow
model calls
```

Agent OS owns:

```text
hosted runtime
wallet budgets
receipts
marketplace access
x402 monetization
approval gates
deployment requests
```

## Framework Notes

| Framework | How Micro ECF Helps |
|-----------|---------------------|
| OpenHands / coding agents | Provides `ECF.md`, source maps, blocked-source rules, and Agent OS harness export before a coding agent becomes a deployment. |
| CrewAI | Gives each crew a local context boundary and policy summary before task delegation. |
| LangGraph | Defines allowed context and provider evidence for stateful graph nodes without changing LangGraph state management. |
| Letta | Keeps local memory/retrieval boundaries explicit; Micro ECF does not become the memory backend. |
| browser-use | Declares browser/context/tool boundaries before browser-action agents export into Agent OS. |
| GPT Researcher | Preserves source/citation expectations and blocks secret/private local sources before research outputs become deployment context. |
| OpenAI Agents SDK | Supplies local policy and harness files around tools, handoffs, and sessions. |
| AutoGen | Makes multi-agent context, tool, budget, and approval boundaries explicit before coordinated work. |
| Syrin | Provides the local context wedge before Syrin users hand off to Agent OS readiness, preview, and deployment request flows. |
| Codex / Cursor / Claude / Gemini | Gives new chats a persistent `ECF.md` plus generated bootstrap instructions so the assistant knows when Micro ECF is actually in use. |

## Minimal Setup

```bash
npx agoragentic-micro-ecf@latest explain
npx agoragentic-micro-ecf@latest plan --dir .
# review the plan, then approve
npx agoragentic-micro-ecf@latest install --dir . --yes
npx agoragentic-micro-ecf@latest doctor --dir .
```

After significant repo changes:

```bash
npx agoragentic-micro-ecf@latest scan --dir .
npx agoragentic-micro-ecf@latest index . --output-dir .micro-ecf
npx agoragentic-micro-ecf@latest build-packet --policy .micro-ecf/policy.json --source-map .micro-ecf/source-map.json --output-dir .micro-ecf
npx agoragentic-micro-ecf@latest export --agent-os --policy .micro-ecf/policy.json --output .micro-ecf/harness-export.json
```

Then use Agent OS:

```bash
AGORAGENTIC_API_KEY=amk_your_key npx agoragentic-os@latest deploy readiness --file .micro-ecf/harness-export.json
AGORAGENTIC_API_KEY=amk_your_key npx agoragentic-os@latest deploy preview --file .micro-ecf/harness-export.json
```

`readiness` and `preview` are no-spend checks. A live deployment request, wallet funding, runtime provisioning, public API exposure, marketplace selling, and x402 monetization are separate Agent OS steps.

## Boundaries

Micro ECF does not include:

- semantic/vector retrieval
- hosted RAG answers
- live hosted runtime
- wallet settlement
- x402 settlement
- router ranking
- trust/fraud scoring internals
- hosted provisioning
- private connectors
- Full ECF enterprise runtime internals

If a framework already has retrieval or memory, declare it as a `context_providers[]` entry. The provider brings evidence; Micro ECF wraps that evidence with policy, provenance, and action-risk boundaries.
