---
name: risk-fork-hackathon-demo
description: Inspect deterministic fork-before-risk behavior over named local synthetic fixtures. Use only for the Risk Fork hackathon protocol simulator, never for live protection or real risky actions.
license: Apache-2.0
metadata:
  entrypoint: risk-fork/hackathon/bin/risk-fork-demo.mjs
  status: experimental_source_demo
  external_provider_network: disabled
  loopback: serve_only
  provider_calls: 0
  e2b_status: not_live_qualified
---

# Risk Fork Hackathon Demo

> **DEMO ONLY — LOCAL PROTOCOL SIMULATOR — NOT AN ISOLATION BOUNDARY — NO LIVE PROTECTION**

Use this skill only when a user wants to inspect or demonstrate one of the
included synthetic Risk Fork fixtures. It is a local source/demo surface. It is
not production-ready, does not protect live traffic, grants no authority, makes
zero provider calls, uses no external/provider network or credentials, performs
no clean commit, is not published to npm, and is not hosted. `serve` alone uses
token-protected local loopback transport. E2B is `not_live_qualified`.

## How the agent knows when to use it

The local host exposes a closed scenario interface through the pinned stdio
connector. The agent may select one enumerated fixture ID. It must not decide or
supply its own risk level or provider: the host owns the fixture metadata,
provider profile, and deterministic classifier input, then decides whether a
local reference copy or injected fake-E2B contract is required.

Use it for requests such as:

- “Show me how Risk Fork handles the HIGH filesystem-write fixture.”
- “Run the fake-E2B malicious MCP containment fixture.”
- “Replay the irreversible prepare-only lifecycle.”
- “Inspect cleanup evidence for the cleanup-unknown fixture.”

Do not use it to execute or protect a real action. If a request includes an
arbitrary command, path, URL, remote MCP server, production workspace, private
repository, credential, wallet, account, provider, deployment, publication, or
payment, explain that this demo cannot protect it and stop.

## Entrypoint and commands

Run the pinned source with local Node:

```powershell
npm --prefix risk-fork ci --ignore-scripts --no-audit --no-fund
node risk-fork/hackathon/bin/risk-fork-demo.mjs doctor
node risk-fork/hackathon/bin/risk-fork-demo.mjs plan --scenario <id>
node risk-fork/hackathon/bin/risk-fork-demo.mjs run --scenario <id>
node risk-fork/hackathon/bin/risk-fork-demo.mjs serve
node risk-fork/hackathon/bin/risk-fork-demo.mjs config --client <client>
node risk-fork/hackathon/bin/risk-fork-demo.mjs cleanup
node risk-fork/hackathon/bin/risk-fork-demo.mjs verify-offline-kit
```

The install command is required for a source checkout. A verified offline kit
already bundles the dependency closure; do not run `npm install` or `npm ci`
inside a kit extraction. In result records, `network_used: false` means no
external/provider network. The `serve` command is the sole loopback-only
transport path.

`doctor` and `plan` write nothing. `config` writes nothing unless the owner
reviews the exact target and explicitly repeats it with `--yes`. Generated
configuration must use local `node` plus the absolute pinned entrypoint; never
resolve the `agoragentic-mcp` npm name. `--yes` writes a review artifact beneath
the owned demo root, not a live client configuration. Mark an untested client
configuration `generated_not_client_verified`.

## Allowed scenario IDs

- `low-read-only`
- `elevated-owner-policy`
- `high-filesystem-write`
- `high-incomplete-metadata`
- `high-untrusted-discovery`
- `high-prompt-injection`
- `e2b-malicious-mcp-containment`
- `irreversible-deployment-proposal`
- `deny-owner-policy`
- `cleanup-unknown`
- `stale-governance-binding`
- `malformed-lifecycle-receipt`
- `attack-traversal`
- `attack-link`
- `attack-secret`
- `attack-oversized-write`
- `attack-timeout`
- `attack-concurrency`

Reject unknown IDs and all free-form operation arguments.

## Result checks

Every result must retain all of these values:

```json
{
  "demo_only": true,
  "local_protocol_simulator": true,
  "production_ready": false,
  "live_traffic_protected": false,
  "authority_granted": false,
  "provider_calls": 0,
  "network_used": false,
  "credentials_used": false,
  "clean_commit_performed": false
}
```

Treat any missing or weakened value as failure. LOW and DENY paths do not
allocate a fork. HIGH uses only the local reference protocol simulator, except
the single `e2b-malicious-mcp-containment` fixture, which uses the real E2B
adapter with an injected fake SDK. It remains a local contract simulation with
zero provider calls.
IRREVERSIBLE remains prepare-only. Cleanup requires both a destruction request
and separate absence verification; `unknown` or `failed` cleanup is not success.
The recorder must label ordinary HIGH execution
`local_reference_protocol_execution` and the flagship execution
`fake_e2b_protocol_execution`. Every profile must show
`isolation_boundary: false` and derive receipt verification by recomputing the
hash and binding it to the replay record.

Runtime fixture data stays under the marker-bound owned local demo root
identified only by the redacted reference from `doctor`. The Git repository
stores public draft source, not runtime forks; generated kits remain local until
a separate publication action is authorized. Do not broaden cleanup or claim a
production deletion SLA.

The official local demo permits one active run and ten completed runs between
explicit cleanup resets; it is not a daily allowance. Its Apache-2.0 source can
be copied or modified subject to the license and NOTICE. Commit/manifest
verification identifies official reviewed bytes, while the closed fixtures and
limits constrain only this official demo and cannot prevent harmful third-party
forks.
