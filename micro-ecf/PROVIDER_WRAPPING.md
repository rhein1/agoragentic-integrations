# Wrapping Existing Context Providers

Micro ECF does not replace your RAG, code graph, database agent, or MCP server.

It wraps those systems with a local governance envelope:

```text
your context provider -> provider evidence -> Micro ECF policy boundary -> Agent OS / Consequences review
```

Use this when you already have a context system and want the agent to know:

- which provider is allowed
- which source classes are allowed or blocked
- which action classes must consult the provider
- whether the agent should fail closed when the provider is unavailable
- which evidence the provider must return before the agent acts

## Provider Contract

Context providers live in `context_providers` inside a Micro ECF policy.

Minimum shape:

```json
{
  "provider_id": "ctx_local_rag",
  "type": "retrieval_context",
  "provider": "local_rag",
  "mode": "local_mcp",
  "enabled": true,
  "scope": "workspace",
  "capabilities": ["query", "retrieve", "cite"],
  "required": false,
  "required_for_action_classes": ["read_only", "code_change"],
  "mcp": {
    "server": "local-rag",
    "transport": "stdio"
  }
}
```

Important fields:

- `type`: the class of context provider. Use `retrieval_context` for RAG/document retrieval, `code_graph` for GitNexus-style code graphs, and `tool_graph` for tool/API dependency maps.
- `provider`: the provider name in your local stack.
- `mode`: `local_mcp`, `remote_mcp`, or `http_api`.
- `capabilities`: what the provider can return. Keep these concrete: `query`, `retrieve`, `cite`, `impact`, `detect_changes`, `generate_map`.
- `required`: when `true`, actions that require this provider should fail closed if the provider is unreachable.
- `required_for_action_classes`: action classes that should consult the provider before execution.

## Example 1: Local RAG Provider

Use this when you already have a local RAG server or MCP tool.

```json
{
  "provider_id": "ctx_local_rag_docs",
  "type": "retrieval_context",
  "provider": "local_rag",
  "mode": "local_mcp",
  "enabled": true,
  "scope": "docs_and_repo",
  "capabilities": ["query", "retrieve", "cite"],
  "required": false,
  "required_for_action_classes": ["read_only", "code_change"],
  "mcp": {
    "server": "local-rag",
    "transport": "stdio"
  },
  "evidence_contract": {
    "must_return_source_ids": true,
    "must_return_citations": true,
    "must_return_confidence": true,
    "raw_secret_content_allowed": false
  }
}
```

Micro ECF does not build the embeddings, vector index, or answers. Your RAG provider does retrieval. Micro ECF governs what the provider may expose and what evidence must accompany its output.

## Example 2: GitNexus Code Graph Provider

Use this when code changes need structural awareness.

```json
{
  "provider_id": "ctx_gitnexus_local",
  "type": "code_graph",
  "provider": "gitnexus",
  "mode": "local_mcp",
  "enabled": true,
  "scope": "workspace",
  "capabilities": ["impact", "context", "query", "detect_changes", "generate_map"],
  "required": false,
  "required_for_action_classes": ["code_change"],
  "mcp": {
    "server": "gitnexus",
    "transport": "stdio"
  },
  "evidence_contract": {
    "must_return_impacted_files": true,
    "must_return_upstream_callers": true,
    "must_return_downstream_dependencies": true,
    "must_return_confidence": true
  }
}
```

The code graph provider answers structural questions. Micro ECF records whether that provider is allowed and whether its evidence is required before a code-changing action.

## Example 3: Database Context Provider

Use this when a local database assistant or schema explorer provides context.

```json
{
  "provider_id": "ctx_local_db_schema",
  "type": "retrieval_context",
  "provider": "database_mcp",
  "mode": "local_mcp",
  "enabled": true,
  "scope": "schema_only",
  "capabilities": ["query", "schema_summary", "cite"],
  "required": true,
  "required_for_action_classes": ["code_change", "external_write"],
  "mcp": {
    "server": "database-context",
    "transport": "stdio"
  },
  "evidence_contract": {
    "schema_only": true,
    "raw_rows_allowed": false,
    "must_return_table_names": true,
    "must_return_risk_notes": true
  }
}
```

For local Micro ECF, prefer schema summaries and sampled/synthetic examples over raw customer rows. Full customer data handling belongs in Full ECF or a customer-approved private runtime.

## Pre-Action Lifecycle

For a code or tool action, the desired flow is:

```text
1. Agent proposes an action.
2. Micro ECF checks the policy and provider bindings.
3. The relevant provider returns evidence, not unchecked authority.
4. Consequences review scores risk from policy plus provider evidence.
5. Agent OS allows, limits, asks for review, or blocks.
```

Micro ECF should never silently downgrade a provider failure into “safe.” If a provider is marked `required: true`, the action should fail closed when the provider is unavailable.

## What Not To Put In Micro ECF

Do not add these to a public Micro ECF provider:

- raw API keys or database credentials
- embeddings or vector indexes
- private Full ECF context graphs
- customer files or private row data
- hosted router/provider-ranking logic
- wallet settlement or x402 settlement logic
- operator prompts or enterprise approval internals

Provider contracts should be portable, local-first, and safe to publish.
