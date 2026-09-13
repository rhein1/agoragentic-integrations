# Agoragentic Risk Fork — Runtime Dynamic entry

**Buy the answer. Not the attack.** An agent selects the least-expensive information source that meets the user's freshness, detail and budget requirements. It can choose free information, select a suitable fixture report, reject a malicious bargain, or refuse an unaffordable task.

**Canonical home:** `risk-fork/examples/runtime-dynamic/` in `rhein1/agoragentic-integrations`. [Draft PR #397](https://github.com/rhein1/agoragentic-integrations/pull/397). This is an example of the existing Risk Fork package, not another repository, company or wallet product.

## What actually runs

| Mode | Behavior | Limit |
| --- | --- | --- |
| Browser rehearsal | Task-dependent choices, attack/refusal scenarios, brief and evidence export | Illustrated Risk Fork; no backend, Dynamic call or payment |
| Node reference demo | Existing Risk Fork savepoint, child execution, typed-artifact validation, destruction and absence checks | Real local-reference protocol, not production OS isolation; purchase mocked |
| Dynamic runner candidate | Separate owner-operated Server Wallet testnet-action source | Actual SDK/native behavior and provider execution unqualified; no live action performed |

The agent uses a deterministic constrained decision policy, not an LLM. Company data and services are synthetic. A future confirmed testnet transfer would not prove a commercial API purchase, mainnet settlement, or production protection.

## Show it to people

Open [the presenter guide](public/presenter.html) for the introduction, three-minute walkthrough, expected outputs and audience FAQ. Open [the presentation](public/presentation.html) for eight branded slides; arrow keys navigate and F requests fullscreen. Print the deck to PDF for a backup.

Use the workbench presets in order: **Free answer → Useful purchase → Inject an attack → Revoke permission**. Nontechnical audiences can explore the browser rehearsal. For developers/judges, screen-share the Node reference demo and export its evidence. Never describe either as a working Dynamic payment.

## Run locally

Use Node 22 or later. From the repository root:

```sh
npm --prefix risk-fork ci --ignore-scripts --no-audit --no-fund
node risk-fork/examples/runtime-dynamic/server.mjs
```

Open `http://127.0.0.1:8787`. The badge must read **Node / local-reference Risk Fork**. Keep the process credential-free and loopback-only. Ctrl+C stops the server.

For the browser-only rehearsal, run the same command with `--static`. Only `public/` may be published to a static host. There is no public signing endpoint; do not expose the local execution server or publish `live/` and operator state.

## Test

```sh
node --test risk-fork/test/runtime-dynamic-agent.test.mjs risk-fork/test/runtime-dynamic-reference.test.mjs risk-fork/test/runtime-dynamic-brand.test.mjs
npm --prefix risk-fork test
```

The existing test wildcard discovers all three suites; no new workflow is needed here. Initial source `9603f222` passed hosted Risk Fork CI: **697 passed, 1 skipped, 0 failed**, including the three actual-reference tests. Brand follow-up evidence is tracked separately on the PR; see [VALIDATION.md](docs/VALIDATION.md).

## Branding

Existing Agoragentic navy `#0c1222`, coral `#e8613a`, paper `#f5f1e9`, coral inset mark and agora/gentic wordmark. Font stacks follow Space Grotesk / Inter / JetBrains Mono with system fallbacks. No font files or third-party network assets are bundled. This does not invent a new logo or brand.

## Live action remains a separate gate

Read [LIVE_RUNBOOK.md](docs/LIVE_RUNBOOK.md). The candidate is explicitly a **developer-owned Dynamic Server Wallet**, not a remapped `provider_managed` contract. It has no provider-policy enforcement claim. The existing local-reference adapter is not a production security boundary.

The runner requires owner review, exact-head hosted CI evidence, a reviewed SDK lockfile/native install, an exact plan hash, expiring approval, dedicated test accounts and private operator state. It is disabled by default. No wallet creation, faucet, arbitrary calldata, token allowance, mainnet or production activation is provided. Do not supply credentials to the website, model or preparation process.

## Materials

- [Requirements and unresolved organizer questions](docs/REQUIREMENTS.md)
- [Submission draft and presenter script](docs/SUBMISSION.md)
- [Presenter guide pointer](docs/PRESENTER_GUIDE.md)
- [Validation evidence](docs/VALIDATION.md)

Existing Risk Fork predates the event; reuse is disclosed. Testnet acceptance, pre-existing-code rules, deterministic-agent eligibility, exact deadline and required submission assets remain organizer questions. This PR is not a registration or submission.

## License

Apache-2.0, matching the surrounding Risk Fork package. Copyright 2026 Jeremy Borden / Agoragentic. The example imports the existing runtime instead of copying it. No Dynamic native binaries, signing material or font files are redistributed.
