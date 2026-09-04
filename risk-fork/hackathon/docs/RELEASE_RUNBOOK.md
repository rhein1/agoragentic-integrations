# Risk Fork hackathon release runbook

> DEMO ONLY — LOCAL PROTOCOL SIMULATOR — NOT AN ISOLATION BOUNDARY — NO LIVE PROTECTION

This runbook produces a dependency-complete, exact-commit offline demonstration ZIP. It does not publish npm, create a GitHub Release, contact E2B, deploy a service, enable interception, or protect live agent traffic.

## What the release candidate contains

For source commit `<sha>`, the build writes one commit-pinned directory containing:

- `risk-fork-hackathon-demo-<short-sha>.zip` — the offline demo, including its exact six-package runtime dependency closure;
- `risk-fork-hackathon-demo-<short-sha>.sha256` — the canonical ZIP checksum;
- `risk-fork-hackathon-demo-<short-sha>.spdx.json` — an SPDX 2.3 SBOM for the source package and bundled dependencies; and
- `risk-fork-hackathon-demo-<short-sha>.build.json` — the exact source, ZIP, checksum, SBOM, and claim-boundary record.

The ZIP also has its own `MANIFEST.json`, with a SHA-256 and byte count for every payload file. The build fails if the checked-out commit is not exact, the `risk-fork/` worktree is dirty, the output is inside a Git repository, the dependency closure drifts, or the local npm cache cannot satisfy the lockfile without network access.

## Required source checks

Use Node.js 22 for the release candidate. Core dependency installation may access npm to populate the local cache; the demo package has no dependencies and needs no separate install. Artifact construction and all demo execution after that point are provider-free and guarded against external network use.

PowerShell:

```powershell
git status --short
npm --prefix risk-fork ci --ignore-scripts --no-audit --no-fund
npm --prefix risk-fork run check
npm --prefix risk-fork test
npm --prefix risk-fork run test:package
npm --prefix risk-fork/hackathon run check
npm --prefix risk-fork/hackathon test
```

Bash:

```bash
git status --short
npm --prefix risk-fork ci --ignore-scripts --no-audit --no-fund
npm --prefix risk-fork run check
npm --prefix risk-fork test
npm --prefix risk-fork run test:package
npm --prefix risk-fork/hackathon run check
npm --prefix risk-fork/hackathon test
```

`npm run test:package` packs the real npm candidate and verifies an offline consumer install plus runtime lifecycle. It is deliberately separate from the ordinary source test suite.

## Build outside every Git repository

PowerShell:

```powershell
$releaseRoot = Join-Path ([System.IO.Path]::GetTempPath()) "risk-fork-release-$([guid]::NewGuid().ToString('N'))"
$env:AGORAGENTIC_NO_SPEND = '1'
$env:AGORAGENTIC_ALLOW_REAL_SPEND = '0'
$env:AGORAGENTIC_ALLOW_NETWORK_CANARIES = '0'
$env:RISK_FORK_DEMO_ALLOW_LOOPBACK = '0'
$env:RISK_FORK_RELEASE_SOURCE_SHA = (git rev-parse HEAD).Trim()
$env:RISK_FORK_RELEASE_OUTPUT_BASE = $releaseRoot
node risk-fork/hackathon/scripts/build-release-artifacts.mjs
```

Bash:

```bash
release_root="$(mktemp -d)/risk-fork-release"
export AGORAGENTIC_NO_SPEND=1
export AGORAGENTIC_ALLOW_REAL_SPEND=0
export AGORAGENTIC_ALLOW_NETWORK_CANARIES=0
export RISK_FORK_DEMO_ALLOW_LOOPBACK=0
export RISK_FORK_RELEASE_SOURCE_SHA="$(git rev-parse HEAD)"
export RISK_FORK_RELEASE_OUTPUT_BASE="$release_root"
node risk-fork/hackathon/scripts/build-release-artifacts.mjs
```

Do not reuse an output directory. The builder never overwrites an artifact.

## Fresh-extraction verification

The verifier checks the external build manifest, checksum, SPDX SBOM, canonical ZIP structure, internal file manifest, offline runtime suite, cleanup, and a real JSON-RPC/MCP exchange over stdio.

PowerShell:

```powershell
$fresh = Join-Path ([System.IO.Path]::GetTempPath()) "risk-fork-fresh-$([guid]::NewGuid().ToString('N'))"
$record = Join-Path ([System.IO.Path]::GetTempPath()) "risk-fork-client-verification-$([guid]::NewGuid().ToString('N')).json"
node risk-fork/hackathon/scripts/verify-release-artifacts.mjs --artifacts $releaseRoot --extract-to $fresh --record $record
```

Bash:

```bash
fresh="$(mktemp -d)/risk-fork-fresh"
record="$(mktemp -d)/risk-fork-client-verification.json"
node risk-fork/hackathon/scripts/verify-release-artifacts.mjs \
  --artifacts "$release_root" \
  --extract-to "$fresh" \
  --record "$record"
```

The conformance record proves the included minimal client completed MCP initialize, tool discovery, plan, run, receipt lookup, and verified cleanup. It does **not** prove Codex, Claude Desktop, Cursor, or another GUI client accepted a configuration; those statuses remain `unknown_not_tested` until separately observed and recorded.

## CI behavior

`.github/workflows/risk-fork-release.yml` builds and verifies a fresh extraction on Windows, macOS, and Linux. Each operating system retains its own client-verification JSON for 14 days; Linux also retains the ZIP and sidecars. The workflow has only `contents: read`; it cannot create a tag, GitHub Release, npm publication, deployment, or provider resource.

## Publication gate

Publishing is a separate owner-controlled decision. Before any GitHub Release or npm publication:

1. select one exact signed commit and require all ordinary Risk Fork and release-candidate checks to pass on that commit;
2. download the CI artifact and independently match the ZIP checksum and build manifest to that commit;
3. review the SPDX SBOM, `LICENSE`, `NOTICE`, and claim boundary;
4. record a release decision and obtain explicit repository-owner authorization;
5. create a non-production prerelease first; and
6. keep npm publication, GitHub Release creation, provider qualification, deployment, and live activation as separate gates.

No command in this runbook grants publication authority. A GitHub Actions artifact is temporary build evidence, not a public release.
