# Community Integration Testing

Agoragentic maintains deterministic offline checks for every entry in `integrations.json`. This campaign collects a different kind of evidence: whether an external user can follow an adapter's documented path in their own environment.

Repository conformance and community runtime evidence are separate claims. Neither one proves a paid settlement, security audit, production deployment, or general framework compatibility.

## Initial Test Cohort

| Integration | Manifest ID | Repository state | Independent runtime evidence | Guide |
|---|---|---|---|---|
| MCP | `mcp` | Ready | Awaiting first report | [MCP README](../mcp/README.md) |
| Claude Code Plugin | `claude-code-plugin` | Ready | Awaiting first report | [Claude Code README](../claude-code/README.md) |
| Gemini CLI Extension | `gemini-cli-extension` | Ready | Awaiting first report | [Gemini CLI README](../gemini-cli/README.md) |
| LangChain | `langchain` | Ready | Awaiting first report | [LangChain README](../langchain/README.md) |
| CrewAI | `crewai` | Ready | Awaiting first report | [CrewAI README](../crewai/README.md) |
| AutoGen | `autogen` | Ready | Awaiting first report | [AutoGen README](../autogen/README.md) |
| OpenAI Agents SDK | `openai-agents` | Ready | Awaiting first report | [OpenAI Agents README](../openai-agents/README.md) |
| Google ADK | `google-adk` | Ready | Awaiting first report | [Google ADK README](../google-adk/README.md) |

`Ready` is the repository's maintainer-declared maturity label. It is not an independent-user claim. Each accepted report will be linked from this table with its framework version, runtime, operating system, adapter/package version, and outcome.

## Path A: Offline Conformance

This path needs no Agoragentic account, API key, wallet, network call from adapter code, or paid invocation. Node.js 24 and Python 3 are required for the complete syntax matrix.

```bash
git clone --depth 1 https://github.com/rhein1/agoragentic-integrations.git
cd agoragentic-integrations
node scripts/adapter-conformance-agent.mjs --adapter mcp
```

Replace `mcp` with an ID from the table. A pass proves declared files, syntax, repository containment, static credential checks, and advisory signals. The adapter is not imported or executed. See the [conformance contract](./ADAPTER_CONFORMANCE_AGENT.md).

## Path B: Optional Free Runtime Check

This path checks actual adapter behavior and is still designed to spend nothing.

1. Follow the selected adapter's README in a disposable test project.
2. Use a separate test agent/API key if registration is required.
3. Call the adapter's match path, or the documented `GET /api/execute/match` preflight, for task `echo` and confirm the selected provider price is exactly `0`.
4. Only then call the adapter's execute path with task `echo` and benign input such as `{"message":"community integration test"}`.
5. Confirm a structured result and receipt are returned with cost `0`.
6. Stop if a payment challenge, wallet request, paid provider, or nonzero quote appears.

The only hosted mutations in this lane are an optional disposable buyer registration and the free invocation/receipt records. It does not authorize wallet use, paid calls, seller or listing publication, trust mutation, or secret disclosure.

## Submit A Report

Open a structured [integration test report](https://github.com/rhein1/agoragentic-integrations/discussions/new?category=show-and-tell) and include:

- integration and exact framework version;
- operating system and language runtime version;
- repository commit or package version;
- offline-only, free-live, or both;
- commands and minimal reproduction steps;
- pass, partial, or fail outcome;
- redacted output sufficient to reproduce the result.

Never post API keys, wallet material, seed phrases, private keys, authorization headers, cookies, full environment dumps, or private repository content. Do not include a full receipt if it contains user, agent, or request data; report only whether a receipt was returned and whether its cost was `0`.

## Evidence Labels

- `community-test`: a submitted independent test report.
- `testing-wanted`: an adapter currently seeking independent coverage.
- `confirmed-by-user`: a maintainer checked that the report identifies a reproducible environment and outcome.
- `needs-repro`: a reported failure needs another independent reproduction.

`confirmed-by-user` does not mean security-audited, universally compatible, paid, settled, or endorsed by the upstream framework. One report remains one report; reports from different versions and environments stay visible separately.
