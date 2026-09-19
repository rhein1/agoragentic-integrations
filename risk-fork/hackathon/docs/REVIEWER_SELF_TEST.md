# Risk Fork reviewer self-test: no provider spend

> **DEMO ONLY — LOCAL PROTOCOL SIMULATOR — NOT AN ISOLATION BOUNDARY — NO LIVE PROTECTION**

Reviewers can exercise the Risk Fork decision, MCP wire, receipt, and cleanup
path on their own computer without an E2B account, API key, wallet, cloud
sandbox, or model call. The built-in probe is the zero-provider-spend path. A
separately connected agent client may charge for its own model usage; that is
outside this demo's no-spend claim.

## Public download available now

The [Risk Fork v0.1.0 alpha prerelease](https://github.com/rhein1/agoragentic-integrations/releases/tag/risk-fork-v0.1.0-alpha.1)
contains a downloadable offline ZIP, SHA-256 sidecar, build manifest, and SPDX
SBOM. It is an **older preview**, built from `04ea56629e0a...`, not the latest
source. Its ZIP is
`risk-fork-hackathon-demo-04ea56629e0a.zip`, with published SHA-256
`de44c905558af17cfeef1402130e313e835eef54caca4139dd6038b5e4bf21ad`.
Check the release page and sidecar again before distributing it. A newer GitHub
Actions artifact is temporary CI evidence, not a durable public download.

On Windows, save the ZIP and sidecar in a reviewer-selected directory, then
compare the ZIP hash with the sidecar **and** the release asset digest before
extracting. For example:

```powershell
$zip = 'C:\path\chosen\risk-fork-hackathon-demo-04ea56629e0a.zip'
$expected = 'de44c905558af17cfeef1402130e313e835eef54caca4139dd6038b5e4bf21ad'
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
  throw 'Risk Fork ZIP checksum mismatch; stop before extraction'
}
```

Use a new, empty extraction directory. Do not overwrite an existing directory
or extract over another checkout. From the extraction root, with Node.js 20 or
newer installed:

```powershell
$destination = 'C:\path\new-risk-fork-review'
if (Test-Path -LiteralPath $destination) { throw 'Choose a new extraction directory' }
Expand-Archive -LiteralPath $zip -DestinationPath $destination
Set-Location -LiteralPath $destination
node .\risk-fork\hackathon\bin\risk-fork-demo.mjs verify-offline-kit
node .\risk-fork\hackathon\scripts\mcp-client-conformance.mjs
node .\risk-fork\hackathon\bin\risk-fork-demo.mjs plan --scenario e2b-malicious-mcp-containment
node .\risk-fork\hackathon\bin\risk-fork-demo.mjs run --scenario e2b-malicious-mcp-containment
node .\risk-fork\hackathon\bin\risk-fork-demo.mjs serve
```

The `serve` command prints a token-bearing loopback URL for the local Flight
Recorder. Open it only on that computer; stop the server with Ctrl+C. Then run:

```powershell
node .\risk-fork\hackathon\bin\risk-fork-demo.mjs cleanup
```

Expected evidence is a verified kit, a real JSON-RPC/MCP stdio exchange, a
deterministic HIGH decision, a **fake-E2B** child contract simulation, a
tainted typed result, unchanged synthetic parent, separate destruction and
absence checks, and `prepared_not_committed`. The container, E2B cloud, live
Marketplace, and external agent tool route are **not** exercised by those
commands. Do not run `npm install` in the extracted kit or provide credentials.

If integrity, MCP conformance, or cleanup is not verified, stop and report the
exact command and sanitized result. Do not reinterpret a failed check as a
successful sandbox demonstration.

## Optional local container experiment

In a newly built, manifest-verified kit containing this revision, the entire
offline integrity, Risk Fork fixture, MCP conformance, and cleanup check is one
command from the extraction root:

```powershell
node .\risk-fork\hackathon\scripts\reviewer-self-test.mjs
```

It reports `verified_local_reviewer_self_test` only when every check passes.
The linked v0.1.0-alpha.1 ZIP does **not** contain this command; use
the commands above for that release. The one-command result is still a local
protocol simulation, not a protected external agent or Docker-backed Risk Fork.

Developers who already have a local Linux Docker engine and a locally present
Node image can additionally run the separate
[Docker MCP example](../docker-example/README.md) from a source checkout. It
uses a fixed synthetic MCP server with no provider API, image pull, host mount,
inherited credential, or container egress. It is **not in the older alpha ZIP**
and is not E2B qualification or proof that arbitrary untrusted code is safe.
Docker daemon access itself is privileged, so use only a machine you control.
For a new kit containing this revision, append `--docker` to the one-command
self-test to also run that independent container probe. It never pulls an
image, and a missing local image fails closed. Its result explicitly says the
container probe is **not** integrated with Risk Fork protection.

## Live E2B boundary

There is no public E2B launch button or attendee cloud allocation in this
release. Real E2B requires a separately approved owner-managed service,
provider qualification, key custody, admission controls, per-reviewer quotas,
cost cap, cleanup reconciliation, and an explicit activation gate. Do not give
reviewers an E2B API key or describe this self-test as live protection.
