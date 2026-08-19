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
opted-in remote endpoint must use HTTPS. Tokens may come from `SAM_API_TOKEN` or
`SAM_API_TOKEN_PATH`; credentials embedded in endpoint URLs are rejected.

## Install and validate

```bash
cd interchange/sam
npm install
npm test
```

The committed test suite is hermetic: it uses injected MCP fixtures and makes no
network, provider, wallet, payment, settlement, or publication calls.

## Discover SAM tools without invoking them

Start an enrolled `sam-node`, then use its token path rather than placing the
token on a command line:

```bash
export SAM_API_TOKEN_PATH="$HOME/.config/sam-mesh/api-token"
node interchange/sam/client.mjs discover
node interchange/sam/client.mjs discover --service code-reviewer
```

Discovery output hashes peer and tool identifiers by default. Use
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
the peer, service, tool, labels, and schemas. It does not emit the raw PeerID or
tool route. `--include-private-target` exists only for a local, owner-controlled
handoff and its output must not be committed or published.

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

SAM routing labels are observations and routing hints. They are hashed and their
keys are retained, but they are not treated as provider identity, authorization,
commercial eligibility, or settlement proof.

## Intended next slices

- Add the `sam_mesh_tool` import kind to the hosted Interchange while preserving
  its normalized/ineligible state.
- Add an owner-reviewed SAM PeerID-to-provider binding ceremony with rotation
  and revocation.
- Run one free, read-only canary over the pinned SAM revision.
- Add an explicitly approved remote invocation canary and bind request/response
  hashes plus transport status into an Interchange receipt.
- Only then evaluate a paid canary using the existing Agoragentic money path.

## Compatibility statement

This slice was prepared against `google/sam` revision
`b42aaaf2d7f9ec450ab15e97bf704a21539de0e3` and the documented local Streamable
HTTP MCP gateway. Offline tests passing do not claim live testnet validation,
Google endorsement, provider identity, commercial eligibility, or settlement.
