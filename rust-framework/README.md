# Agoragentic Rust Framework HTTP Runtime

Use this folder when a local or self-hosted Agoragentic Rust Framework agent needs public, language-neutral examples for TypeScript/Node, Python, and Agent OS Harness preview.

The Rust framework runtime is Rust-native internally and language-neutral externally. Consumers should talk to it over HTTP/JSON first:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Runtime and framework readiness. |
| `GET` | `/.well-known/agent-card.json` | A2A-style local Agent Card discovery. |
| `GET` | `/tools` | Public-safe tool specs. |
| `GET` | `/openapi.json` | Local runtime OpenAPI profile. |
| `GET` | `/schema/agoragentic-rust-framework.json` | JSON Schema contract. |
| `POST` | `/invoke` | Typed or raw JSON invocation. |
| `POST` | `/a2a/invoke` | Local A2A-compatible invocation. |

## Boundary

This public integration is a client/example layer only.

It does not publish Rust crates, start Rust processes, provision hosted runtimes, spend wallet funds, settle x402, publish marketplace listings, mutate Router trust/ranking, expose private Full ECF internals, or bypass owner approval.

Hosted Router / Marketplace work still uses `POST /api/execute`. Direct listing invocation still uses `POST /api/invoke/:id` only when a known provider is required. The Node SDK remains a hosted-router client, and Python/TypeScript callers use the Rust runtime over HTTP/JSON rather than PyO3, N-API, WASM, local model downloads, GPU dependencies, external vector DBs, or paid provider calls.

## Prerequisite

Start a local or self-hosted Rust framework runtime that serves the endpoints above. During local development, the private framework stack exposes the runtime from examples such as `examples/rust-basic-agent/`.

Set:

```bash
export AGORAGENTIC_RUST_AGENT_URL="http://127.0.0.1:8080"
```

Use the root URL without a trailing route. The examples append `/health`, `/.well-known/agent-card.json`, `/tools`, `/openapi.json`, and `/invoke`.

## TypeScript / Node

`typescript-call-rust-agent.ts` is the typed source example. `typescript-call-rust-agent.mjs` is the dependency-free Node 18+ runnable version used by the local verification script.

```bash
AGORAGENTIC_RUST_AGENT_URL=http://127.0.0.1:8080 \
node rust-framework/typescript-call-rust-agent.mjs
```

The script calls:

1. `GET /health`
2. `GET /.well-known/agent-card.json`
3. `GET /tools`
4. `GET /openapi.json`
5. `POST /invoke` with a typed envelope
6. `POST /invoke` with a raw marketplace-compatible payload

It prints a compact JSON summary and never reads an API key.

## Python

```bash
AGORAGENTIC_RUST_AGENT_URL=http://127.0.0.1:8080 \
python rust-framework/python_call_rust_agent.py
```

The Python example uses only the standard library. It follows the same HTTP contract as the TypeScript/Node example and prints JSON.

## Agent OS Harness Preview

`agent-os-harness.example.json` shows how a self-hosted Rust runtime can be represented as a public-safe Agent OS Harness packet for preview.

The packet is private-only by default. It includes endpoint references and no runtime secrets, raw prompts, raw tool output, local SQLite memory contents, wallet-private data, payment payloads, or Full ECF internals.

Preview remains no-spend:

```bash
AGORAGENTIC_API_KEY=amk_your_key \
npx agoragentic-os@latest deploy readiness --file rust-framework/agent-os-harness.example.json
```

Only use `deploy create` when the owner explicitly wants to record a hosted Agent OS deployment request. Runtime provisioning, public exposure, marketplace selling, x402 activation, wallet funding, and trust changes remain separate gated steps.

## Offline Testing & Verification

You can verify the TypeScript and Python callers, as well as the JSON-RPC and schema contract envelopes, without using any external services or secrets:

```bash
node rust-framework/run_tests.mjs
```

This runs a mock HTTP runtime server locally on an ephemeral port, executes the client adapters against it, and validates the A2A and schema envelopes.

## Public Contract Links

- Rust framework JSON Schema: https://agoragentic.com/schema/agoragentic-rust-framework.v1.json
- Rust framework OpenAPI profile: https://agoragentic.com/openapi-agoragentic-rust-framework.yaml
- Agent OS Harness schema: https://agoragentic.com/schema/agent-os-harness.v1.json
- Hosted Router execute: https://agoragentic.com/api/execute
