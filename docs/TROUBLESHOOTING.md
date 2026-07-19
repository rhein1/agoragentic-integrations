# Troubleshooting

Start with the exact integration README and [`integrations.json`](../integrations.json). The entries below reflect errors and safety boundaries implemented or documented in this repository; hosted behavior can still change, so preserve the returned HTTP status and response body when diagnosing a live call.

## `missing_api_key` or HTTP 401

Authenticated Router calls require `AGORAGENTIC_API_KEY`. Set it in the process environment and send it as `Authorization: Bearer amk_...`; do not commit it in source, README examples, exported flow JSON, or reports.

The four direct public tool endpoints in the root README do not require a key, but `POST /api/execute` and adapter calls through the authenticated Router do. The adapter template reports `missing_api_key` with status 401 when the environment variable is absent.

## `invalid_task`

The adapter template requires `task` to be a non-empty string for both match and execute. Pass the routing intent as the task and put structured arguments in `input`:

```javascript
await agoragentic_execute('weather', { latitude: 40.71, longitude: -74.01 });
```

Do not substitute a provider ID for the task unless you intentionally switch to a direct-invoke API.

## `router_request_failed`, HTTP 429, or a 5xx response

The template preserves the Router's error code and message when available and uses `router_request_failed` only as a fallback. It marks HTTP 429 and 5xx responses retryable; other statuses are not retryable by default.

Log the status, structured code, and redacted response details. Back off for 429/5xx responses. Do not blindly retry a validation/auth error, and never turn a 402 response into an automatic signing loop.

## No x402 provider matched

For `GET /api/x402/execute/match`, no match is represented by both `quote: null` and `selected_provider: null`. Stop or change the task/ceiling; do not infer that a missing quote means the route is free.

If a quote is present, require a boolean `payment_required`, a finite non-negative price within the reviewed ceiling, a quote ID, `execution_ready === true`, and the approved settlement network before proceeding. See the [x402 buyer integration](../x402/README.md).

## Execution returned `pending_approval`

This is an approval state, not a completed execution. Use the buyer/supervisor flow in the [Agent OS control-plane example](../agent-os/README.md). After the supervisor approves the one-time request, retry the same `quote_id` and input so the approval remains bound to the reviewed intent.

Do not auto-approve unless the owner has explicitly configured a controlled supervisor account for that behavior.

## A paid preflight returned HTTP 402

That is the expected first response for a paid x402 resource. Decode the `PAYMENT-REQUIRED` challenge, validate the protocol version, exact-transfer scheme, resource, amount, Base network, USDC asset, and independently configured recipient, then stop unless a wallet owner has authorized signing.

The repository's [buyer paid-preflight](../x402/README.md) and [receipt-reconciliation preflight](../interchange/examples/x402-receipt-reconciliation/README.md) deliberately do not read a private key, sign, retry, or spend.

## A paid retry returned a second 402

Fail closed. Do not create another signature or payment attempt. The hardened wallet wrapper and repository payment-safety contracts treat a second 402 after authorization as a failure, and locally block reused intent keys within one client instance.

Also remember that the manual example's idempotency key is a caller-side guard; the endpoint does not promise server-side route deduplication from that key.

## I have a receipt, but is it settled?

Do not collapse receipt presence, payment submission, and terminal settlement into one state. Fetch or verify the receipt, inspect its settlement/proof fields, and preserve any pending state. For the documented x402 invocation proof, only `on_chain.status === "verified"` confirms the proof on-chain.

Use the [read-only public verifier example](../interchange/examples/verify-receipt/README.md) for receipt IDs or receipt JSON. Its `--demo-missing` mode is a safe way to verify the client path without supplying a real receipt.

## Adapter conformance says `Unknown integration id(s)`

`--adapter` accepts manifest IDs, not display names or directory guesses. Copy the exact `id` from [`integrations.json`](../integrations.json):

```bash
node scripts/adapter-conformance-agent.mjs --adapter langchain,crewai
```

If the ID is new, add a complete manifest entry before running the targeted check.

## Adapter conformance fails or reports advisories

Use the failing check ID in the text output or JSON report:

| Check | What to inspect |
|---|---|
| `manifest_fields` | `id`, `name`, `language`, `status`, `path`, and `docs` must be non-empty strings |
| `primary_path` / `docs_path` | Paths must exist, remain repository-relative, and not escape through traversal or symlinks |
| `primary_syntax` | Parse the declared JavaScript, TypeScript, Python, or JSON artifact without executing it |
| `credential_literals` | Remove the credential-shaped value; the report intentionally records only its rule and path |
| `execute_first_signal` | Advisory: add the current execute-first path to the artifact or docs |
| `colocated_tests` | Advisory: add a hermetic adapter-local test if runtime behavior needs proof |

A pass is offline static and syntax evidence only. It does not prove dependency installation, framework runtime behavior, a live endpoint, a verified receipt, or settlement. See the [conformance contract](./ADAPTER_CONFORMANCE_AGENT.md).

## Micro ECF reports `.env` or another source as blocked

For secret-like files, this is the expected safety behavior. Micro ECF may record the path and reason while keeping raw contents out of context packets, Harness exports, Agent OS previews, and MCP responses. Do not unblock or copy the file merely to reduce the blocked count.

Keep safe project knowledge in an allowed documentation source, then rerun the read-only scan and inspect the source map. The [secret-block proof](../micro-ecf/examples/secret-block-proof.md) shows an allowed README and blocked `.env` coexisting correctly.

## The integration is marked Ready, Beta, Experimental, or Deprecated

Treat the label as repository maturity, not proof of every external or live behavior. Read the integration README's status, test coverage, and safety boundary, then consult the [maturity definitions](./GLOSSARY.md#integration-maturity). The offline conformance agent cannot upgrade a live-evidence claim by itself.

## Still stuck?

Collect the integration ID, command, runtime versions, HTTP status, redacted response body, and the smallest offline reproduction. Never include API keys, wallet material, payment signatures, raw private receipts, or customer data in an issue or conformance report.
