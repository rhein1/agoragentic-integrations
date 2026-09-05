# Risk Fork hackathon rehearsal

> DEMO ONLY — LOCAL PROTOCOL SIMULATOR — NOT AN ISOLATION BOUNDARY — NO LIVE PROTECTION

## Honest demo claim

Risk Fork demonstrates a host-side control pattern: classify a proposed tool call before effects, route risky synthetic work into a disposable child protocol, accept only a typed and policy-checked result, verify cleanup, and retain a receipt. The offline demo is not a VM, sandbox, hosted service, production provider qualification, or live agent protection.

## Presenter preflight

At least one day before the event:

1. choose the exact commit that will be shown;
2. obtain the successful `Risk Fork Release Candidate` workflow result for Windows, macOS, and Linux;
3. download the Linux artifact and verify its `.sha256` and `.build.json`;
4. complete the fresh-extraction command in `RELEASE_RUNBOOK.md` on the presentation laptop;
5. retain the generated client-verification record;
6. run the Flight Recorder locally and confirm only `127.0.0.1` or `::1` is used; and
7. rehearse once with Wi-Fi disabled after the ZIP has been downloaded.

Do not place credentials, repositories, wallets, production data, or arbitrary commands into the demo. The scenarios are fixed synthetic fixtures.

## Five-minute live path

From the freshly extracted ZIP directory:

```text
node ./risk-fork/hackathon/bin/risk-fork-demo.mjs doctor
node ./risk-fork/hackathon/scripts/mcp-client-conformance.mjs
node ./risk-fork/hackathon/bin/risk-fork-demo.mjs plan --scenario high-filesystem-write
node ./risk-fork/hackathon/bin/risk-fork-demo.mjs run --scenario e2b-malicious-mcp-containment
node ./risk-fork/hackathon/bin/risk-fork-demo.mjs serve
```

Suggested narration:

- **0:00–0:40 — boundary:** show the banner and say this is an offline protocol simulator, not live protection.
- **0:40–1:20 — host decision:** run `plan`; point to `HIGH`, `RISK_FORK_REQUIRED`, and `before_execution`.
- **1:20–2:30 — malicious synthetic child:** run the fake-E2B scenario; point to eight recorded attack attempts, zero provider calls, unchanged parent state, verified cleanup, and no clean commit.
- **2:30–3:20 — real MCP wire:** show the conformance record proving initialize, `tools/list`, plan, run, and receipt over stdio.
- **3:20–4:30 — visual receipt:** open the loopback Flight Recorder and show the decision, lifecycle, tainted-output boundary, and cleanup evidence.
- **4:30–5:00 — adoption:** explain that a production agent host must enforce this before its tool executor and must supply a qualified disposable provider; the demo itself does neither.

The `serve` command prints the loopback URL. Keep the terminal open while presenting and stop it with Ctrl+C.

## Audience self-service path

Give participants the exact ZIP, `.sha256`, `.spdx.json`, and `.build.json` from one release-candidate artifact. Their shortest path is:

1. match the ZIP SHA-256 to the sidecar;
2. extract into a new empty directory;
3. run `node ./risk-fork/hackathon/bin/risk-fork-demo.mjs verify-offline-kit`;
4. run `node ./risk-fork/hackathon/scripts/mcp-client-conformance.mjs`; and
5. run one fixed scenario and optionally start the local Flight Recorder.

No `npm install`, API key, wallet, cloud account, provider account, or Marketplace account is required for the extracted offline kit.

## Framework and GUI-client stations

The kit can generate portable configuration candidates for `generic`, `codex`, `claude`, and `cursor`, but those files are not proof of installation or compatibility:

```text
node ./risk-fork/hackathon/bin/risk-fork-demo.mjs config --client generic
```

Do not overwrite a participant's real client configuration. Copy the generated JSON into a disposable test profile only after the participant approves the exact destination and diff. Record the result using `CLIENT_VERIFICATION_RECORD.md`.

Current GUI-client status is intentionally **unknown** until a named client version, operating system, exact config, observed four-tool inventory, scenario result, and cleanup result are captured. A successful minimal stdio probe is protocol evidence, not GUI evidence.

## Demo fallback

If the browser cannot open, keep the terminal output: the scenario result and receipt contain the same evidence. If a GUI client cannot register the server, show the included stdio conformance record and label that GUI client `failed` or `unknown_not_tested`; do not imply it worked. If any integrity, source-commit, cleanup, or truth check fails, stop the demo and use a previously verified artifact without modifying its files.

## What a compelling post-hackathon integration still needs

- a documented host adapter that blocks the original tool route before execution;
- a provider-qualified disposable execution backend;
- end-to-end tests in each supported agent framework;
- default-off rollout, quotas, abuse controls, telemetry, and incident response;
- independent security review; and
- evidence that live traffic is actually routed through the boundary.

Until those gates exist, describe the artifact as a working local demonstration and source implementation, not universally active protection.
