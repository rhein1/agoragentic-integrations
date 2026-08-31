# Risk Fork Hackathon Demo: Five-Minute Quickstart

> **DEMO ONLY — LOCAL PROTOCOL SIMULATOR — NOT AN ISOLATION BOUNDARY — NO LIVE PROTECTION**

This walkthrough uses only named synthetic fixtures on the local machine. Demo
runtime makes no provider or external-network call, uses no credential, grants
no authority, and performs no clean commit. Use Node.js 20 or newer.

Run every command from the root of the pinned source checkout or the equivalent
root inside the verified offline kit. A source checkout needs the locked Risk
Fork dependencies. The ordinary setup command below may contact the npm
registry on a cold machine; that setup is outside the zero-network demo-runtime
claim:

```powershell
npm --prefix risk-fork ci --ignore-scripts --no-audit --no-fund
```

A verified offline kit already bundles the dependency closure. Do not run
`npm install` or `npm ci` inside a kit extraction.

For a strictly zero-network walkthrough, use the verified offline kit. A source
checkout with a prewarmed integrity-addressed npm cache may instead use the same
command with `--offline`; it fails closed on a cache miss.

## 1. Check the local demo

```powershell
node risk-fork/hackathon/bin/risk-fork-demo.mjs doctor
```

`doctor` writes nothing. Confirm that it reports a hash-bound entrypoint
reference, supported Node version, a redacted owned-root reference, zero
provider/external-network authority, and this banner:

```text
DEMO ONLY — LOCAL PROTOCOL SIMULATOR — NOT AN ISOLATION BOUNDARY — NO LIVE PROTECTION
```

## 2. Preview and run the flagship fake-E2B fixture

```powershell
node risk-fork/hackathon/bin/risk-fork-demo.mjs plan --scenario e2b-malicious-mcp-containment
node risk-fork/hackathon/bin/risk-fork-demo.mjs run --scenario e2b-malicious-mcp-containment
```

`plan` writes nothing. The run should show deterministic HIGH classification,
the real controller and E2B adapter composed only with an injected fake SDK,
one synthetic sandbox, eight boundary-evaluated synthetic stdio MCP attack
outcomes, a tainted candidate,
one accepted typed result, identical parent before/after hashes, destruction
plus separate simulated provider-API absence evidence, and a final
`prepared_not_committed` result. It must not perform the represented action in
the parent workspace. `provider_calls` remains `0`; this is a local contract
simulation, not an E2B sandbox, OS containment test, or isolation claim.

Every result must include:

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

## 3. Open the Flight Recorder

```powershell
node risk-fork/hackathon/bin/risk-fork-demo.mjs serve
```

Open only the token-bearing loopback URL printed by the process. The recorder is
a local replay of sanitized lifecycle evidence. It is not a live monitor,
hosted page, or isolation control. Leave this process running while inspecting
the timeline, then stop it before cleanup. `network_used: false` excludes
external/provider traffic; the recorder explicitly uses local loopback
transport. For the HIGH record, confirm that the replay shows the deterministic
classifier name and `v1` version, exactly four lanes in this order: Clean
Parent, Policy and Risk Decision, Disposable Fork, and Evidence and Cleanup.
Confirm the execution label is `fake_e2b_protocol_execution`,
`isolation_boundary` is `false`, and the receipt hash and outer-record bindings
are verified. The Evidence and Cleanup lane includes every active-run, completed-run,
workspace-file, workspace-byte, write-byte, action, fork-TTL, execution-timeout,
recorder-byte, and owned-root-byte limit, plus only a bounded sanitized
tainted-output evidence reference and SHA-256 hash. Raw tainted output must read
as not included. The recorder byte limit is cumulative: before persisting the
next record, the demo measures the marker-bound recorder tree and rejects a
write that would take history above 4 MiB.

## 4. Preview an agent configuration

Choose `generic`, `codex`, `claude` (Claude Desktop), or `cursor`:

```powershell
node risk-fork/hackathon/bin/risk-fork-demo.mjs config --client codex
```

The command prints a plan and writes nothing. Review that the configuration uses
the local Node executable and an absolute, pinned path to:

```text
risk-fork/hackathon/bin/risk-fork-demo.mjs
```

It must not resolve the `agoragentic-mcp` npm name. Every generated target uses
the exact primary status `generated_not_client_verified`; any syntax or portable
template claim must remain absent unless separately evidenced. Codex uses the
detail `codex_config_generated_not_live_client_verified`, which is generation
status rather than syntax or live-client verification evidence.

Only after reviewing the generated content and owned-root artifact name, opt in
to writing that review artifact:

```powershell
node risk-fork/hackathon/bin/risk-fork-demo.mjs config --client codex --yes
```

This command does not edit the selected client's real configuration. Manually
merge the reviewed artifact into that client's current documented local MCP
configuration, then restart the client if required. The connector exposes a
closed named-fixture surface. Ask the agent to run
`e2b-malicious-mcp-containment`; do
not give it a real command, path, URL, secret, or workspace.

## 5. Inspect and clean up

Confirm the recorder shows classification, lifecycle, receipt verification, and
cleanup status. Then disconnect the client, stop the Flight Recorder, and run:

```powershell
node risk-fork/hackathon/bin/risk-fork-demo.mjs cleanup
```

The command may clean only marker-bound paths beneath the owned demo root.
It reports destruction and absence verification separately and exits nonzero if
cleanup is `unknown` or `failed`.

## 6. Verify an offline kit

From a fresh extraction of the commit-pinned kit (with no dependency install):

```powershell
node risk-fork/hackathon/bin/risk-fork-demo.mjs verify-offline-kit
```

Verification checks the SHA-256 manifest, artifact sizes, source-commit binding,
supported Node version, representative fixtures, Flight Recorder loopback
smoke, receipt verification, and cleanup without external network or provider
access. The command evaluates the same `>=20` Node-major predicate reported by
`doctor` before it reads the kit manifest or runs representative fixtures. An
invalid or lower current Node version returns `unsupported_node_runtime`, marks
verification false, and exits with code 2.

Continue with
[cleanup and troubleshooting](./CLEANUP_TROUBLESHOOTING.md) if any cleanup or
manifest result is not verified.
