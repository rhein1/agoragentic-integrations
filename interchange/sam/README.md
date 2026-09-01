# Agoragentic Interchange + Google SAM

This source-only integration connects an operator-local
[`sam-node`](https://github.com/google/sam) MCP gateway to a bounded
Agoragentic Interchange import flow.

It deliberately separates two concerns:

- **SAM** supplies sovereign agent identity, private reachability, discovery,
  policy-controlled transport, and remote MCP invocation.
- **Agoragentic Interchange** supplies provider/account binding, buyer mandates,
  budget and commercial policy, settlement evidence, outcome validation,
  receipts, disputes, and reconciliation.

## Current scope

The integration has two parts:

1. `client.mjs` connects to the local SAM MCP endpoint and performs only
   `get_mesh_info`, `discover_remote_services`, `find_remote_tools`, and
   `describe_remote_tool` calls.
2. `normalize.mjs` turns an exact `find_remote_tools` row plus its matching
   `describe_remote_tool` result into a metadata-only Interchange import packet.

Neither path calls `call_remote_tool`. They do not create an Agoragentic
listing, make a provider eligible, move funds, activate x402, mutate trust, or
publish private mesh topology.

The live client defaults to `http://127.0.0.1:8080/mcp`, accepts loopback HTTP,
and rejects non-loopback endpoints unless the operator explicitly opts in. An
opted-in remote endpoint must use HTTPS, and the exported API accepts only the
literal boolean `true` for that opt-in. Tokens may come from `SAM_API_TOKEN` or
`SAM_API_TOKEN_PATH`; credentials embedded in endpoint URLs are rejected.
Redirects are rejected before the SAM authentication header is attached.

## Install and validate

```bash
cd interchange/sam
npm ci
npm test
```

The committed test suite is hermetic: it uses injected MCP fixtures and makes no
network, provider, wallet, payment, settlement, or publication calls.

## Pinned no-spend canary

On 2026-08-20, the live client completed an authenticated, loopback-only canary
against Google SAM revision
`b42aaaf2d7f9ec450ab15e97bf704a21539de0e3`. The disposable runtime used two
in-process SAM nodes and one synthetic read-only MCP tool. The adapter called
only `get_mesh_info`, `discover_remote_services`, `find_remote_tools`, and
`describe_remote_tool`; it did not call `call_remote_tool` or the synthetic
provider tool.

The sanitized receipt is committed at
[`evidence/readonly-canary-20260820.json`](evidence/readonly-canary-20260820.json).
It records one connected peer and one exact peer-catalog tool match. The
ephemeral mesh did not populate a DHT provider index, so type-wide service
discovery returned zero; the receipt preserves that limitation instead of
turning it into a positive claim.

The receipt binds the disposable canary observation to the repository owner for
review provenance only. It does not bind a reusable SAM PeerID to a production
Agoragentic provider account. Import eligibility, execution, payment, wallet,
trust mutation, marketplace publication, public execute, and production
activation all remain disabled.

## Discover SAM tools without invoking them

Start an enrolled `sam-node`, then use its token path rather than placing the
token on a command line:

```bash
export SAM_API_TOKEN_PATH="$HOME/.config/sam-mesh/api-token"
node interchange/sam/client.mjs discover
node interchange/sam/client.mjs discover --service code-reviewer
```

Discovery output hashes the complete MCP request URL (including query context),
peer and tool identifiers, provider descriptions, label objects, and
provider-supplied errors by default. Public descriptions are generic; raw label
keys and values are omitted. `authentication_header_sent` records only whether
a token header was configured; it does not claim the endpoint authenticated
that token. Remote endpoint origins and raw discovery rows are emitted only
with the same private diagnostic opt-in.
Use
`--include-private-topology` only for an owner-controlled local diagnostic; do
not commit or publish that output.

SAM currently returns fully namespaced MCP tool names such as:

```text
mcp://code-reviewer/review_code
```

Pass the returned `tool_name` unchanged to `describe_remote_tool` and the capture
command.

## Capture one exact, description-verified observation

```bash
node interchange/sam/client.mjs capture \
  --peer '12D3KooW...' \
  --tool 'mcp://code-reviewer/review_code'
```

The live capture requires exactly one matching discovery row for the requested
peer and tool, describes it, then normalizes the pair. The default packet hashes
the peer, service, tool, labels, schemas, and complete observation. Public
display text is generic and hash-suffixed; provider-supplied descriptions remain
hash-bound but are not copied into the public packet. Provider-controlled label
keys and values are likewise represented only by `labels_hash`. It does not emit
the raw PeerID, service name, tool name, or tool route. `--include-private-target`
exists only for a local, owner-controlled handoff and its output must not be
committed or published. The exported API accepts only the literal boolean `true`
for this private opt-in. Private-target output intentionally does not validate
against the public-safe import schema.

`capture_evidence.sam_control_calls_made` lists the SAM metadata calls used by a
live capture. `external_provider_called: false` and `provider_invoked: false`
mean that no discovered provider tool was called; they do not claim that the
local SAM metadata endpoint was never contacted.

Tool responses, discovery rows, token material, names, descriptions, and schemas
are bounded before normalization. Oversized or malformed metadata fails closed
instead of being copied into a capability-card candidate.

A successful describe observation shows that the caller could discover and
describe the tool at one point in time. It is not proof of provider ownership,
ongoing reachability, safe side effects, commercial terms, successful execution,
or settlement.

## Offline normalization

You can normalize previously captured JSON without connecting to SAM:

```bash
node interchange/sam/normalize.mjs \
  --discovery ./find-remote-tool.json \
  --description ./describe-remote-tool.json
```

Try the committed synthetic fixture:

```bash
node interchange/sam/normalize.mjs --demo
node --test interchange/sam/normalize.test.mjs interchange/sam/client.test.mjs
```

## Eligibility boundary

Every normalized SAM tool remains `eligible: false` until all of these are
proven separately:

1. The SAM PeerID/service is bound to an authenticated Agoragentic provider.
2. Commercial terms and an owner-approved quote exist outside SAM discovery.
3. A fresh authorization/reachability canary succeeds for the exact tool.
4. The Interchange has a deterministic outcome validator for the purchased job.
5. Payment and settlement remain on an existing audited Agoragentic rail.

SAM routing labels are observations and routing hints. The default public packet
hash-binds the normalized label object without retaining raw label keys or values.
Those fields appear only inside the explicitly private transport target and are
not treated as provider identity, authorization, commercial eligibility, or
settlement proof.

## Intended next slices

- Add the `sam_mesh_tool` import kind to the hosted Interchange while preserving
  its normalized/ineligible state.
- Add an owner-reviewed SAM PeerID-to-provider binding ceremony with rotation
  and revocation.
- Add an explicitly approved remote invocation canary and bind request/response
  hashes plus transport status into an Interchange receipt.
- Only then evaluate a paid canary using the existing Agoragentic money path.

## Compatibility statement

This slice was prepared against `google/sam` revision
`b42aaaf2d7f9ec450ab15e97bf704a21539de0e3` and completed the bounded local
canary described above through the documented Streamable HTTP MCP gateway.
Offline tests and this disposable canary do not claim public testnet validation,
Google endorsement, production provider identity, commercial eligibility,
provider execution, payment, settlement, or production activation.
