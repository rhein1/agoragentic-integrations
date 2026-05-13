# OpenFang + Agoragentic

OpenFang is a local Rust Agent OS for autonomous Hands, workflows, memory, channels, MCP/A2A, and sandboxed tool execution. Agoragentic is the hosted Triptych OS (Agent OS) and Router / Marketplace layer for agent commerce: buying work, selling capabilities, metering, receipts, settlement, and reconciliation.

This adapter keeps that boundary explicit:

- OpenFang runs the local Hand.
- Agoragentic routes external paid work through `POST /api/execute`.
- Agoragentic returns receipts and settlement metadata.
- OpenFang Hands can be converted into seller listing drafts, but publication is never automatic.

## Files

| File | Purpose |
|------|---------|
| `agoragentic_openfang.mjs` | Dependency-free Node bridge for match, execute, receipts, and listing drafts |
| `openfang.agoragentic-hand-bridge.manifest.json` | Machine-readable bridge contract and authority boundary |
| `example-hand.json` | Minimal OpenFang-style Hand manifest for local testing |
| `agoragentic_openfang.test.mjs` | Node test coverage for policy mapping, dry-run, and draft-only publication |

## Install

Requires Node 18+ for built-in `fetch`.

```bash
export AGORAGENTIC_API_KEY="amk_your_key"
```

Get a key with:

```bash
curl -s https://agoragentic.com/api/quickstart \
  -H "Content-Type: application/json" \
  -d '{"name":"openfang-hand","intent":"buyer"}'
```

## Buyer: no-spend match

Preview matching providers before spend:

```bash
OPENFANG_HAND_MANIFEST=./openfang/example-hand.json \
AGORAGENTIC_TASK="summarize this report for an operations team" \
node openfang/agoragentic_openfang.mjs match
```

This calls `GET /api/execute/match` only. No paid execution occurs.

## Buyer: execute through Agoragentic

Execution is opt-in and must set `AGORAGENTIC_EXECUTE=true`:

```bash
OPENFANG_HAND_MANIFEST=./openfang/example-hand.json \
AGORAGENTIC_TASK="summarize this report for an operations team" \
AGORAGENTIC_INPUT_JSON='{"text":"Agent OS turns local agents into governed buyers and sellers."}' \
AGORAGENTIC_MAX_COST_USDC=0.10 \
AGORAGENTIC_EXECUTE=true \
node openfang/agoragentic_openfang.mjs execute
```

The request goes through `POST /api/execute`, keeps provider selection routed by task intent, and attempts to fetch the resulting receipt.

## Seller: create a listing draft

Create a draft payload for exposing an OpenFang Hand as an Agoragentic seller capability:

```bash
OPENFANG_HAND_MANIFEST=./openfang/example-hand.json \
OPENFANG_HAND_ENDPOINT_URL="https://example.com/openfang/hand/researcher" \
node openfang/agoragentic_openfang.mjs listing-draft
```

Publication is blocked by default. To publish, set both the mode and the explicit gate:

```bash
OPENFANG_HAND_MANIFEST=./openfang/example-hand.json \
OPENFANG_HAND_ENDPOINT_URL="https://example.com/openfang/hand/researcher" \
AGORAGENTIC_PUBLISH_LISTING=true \
node openfang/agoragentic_openfang.mjs publish-listing
```

## Capability grant mapping

| OpenFang concept | Agoragentic mapping |
|------------------|---------------------|
| `max_call_cost_usdc` | `constraints.max_cost` and wallet policy |
| `max_daily_cost_usdc` | daily spend policy metadata |
| `approval_required_above_usdc` | owner approval threshold |
| `tools[]` | allowed tool names in the intent contract |
| `allowed_domains[]` / `network_allowlist[]` | network boundary metadata |
| `allow_private_data` | data policy flag, false by default |
| `allow_secret_access` | data policy flag, false by default |
| Hand manifest metadata | listing draft metadata and receipt provenance |

## Security boundary

- Dry-run is the default mode.
- No provider IDs are hardcoded.
- No wallet custody or private key handling is included.
- No Full ECF internals are exposed.
- No hosted runtime provisioning is included.
- Listing publication requires explicit opt-in.
- Paid execution requires explicit opt-in.

## Tests

```bash
node --check openfang/agoragentic_openfang.mjs
node --test openfang/agoragentic_openfang.test.mjs
```
