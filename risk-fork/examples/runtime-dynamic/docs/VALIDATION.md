# Validation record — Runtime Dynamic example

This record distinguishes local tests, hosted evidence, and the still-unqualified wallet path. No independent human security audit or live provider test is claimed.

## Source and hosted evidence

Initial published source: `9603f2220fc6df8f54f2f8532552f991956a5266` on draft [PR #397](https://github.com/rhein1/agoragentic-integrations/pull/397).

[Risk Fork hosted run 34779683264](https://github.com/rhein1/agoragentic-integrations/actions/runs/34779683264), job `103784274246`, completed successfully: **697 passed, 1 skipped, 0 failed**. Logs include all three new tests of the actual local-reference runtime: accepted source with verified cleanup, rejected injected instruction with cleanup, and full source-selection preparation through the real reference adapter. The 27 agent/authorization tests also passed. The rest of the suite includes existing Risk Fork tests; this is not 697 newly written hackathon tests.

This is evidence for that source SHA only. The brand, presenter and documentation follow-up requires its own hosted run. Current exact-head evidence is recorded in the PR, not inferred from an earlier green run.

## Local validation

The initial dependency-free agent/authorization/SDK-wrapper suite passed **27/27** with injected SDK/RPC implementations. No actual Dynamic SDK install, credential use or network operation is established by that result.

The October 5 dependency repair is tracked in [PR #414](https://github.com/rhein1/agoragentic-integrations/pull/414). It retains Dynamic SDK 0.0.225 and viem 2.38.2, pins WalletConnect Utils 2.21.10 and axios 1.20.0, and uses semver-scoped overrides without the npm 11-invalid nested parent override. The current agent/authorization/lock suite passed **28/28**, with zero skips, on Windows Node 24.13.0. Before the repaired lock was regenerated, its new axios-floor assertion failed against 1.18.0; this is retained regression evidence, not a passing run.

Credential-free dependency qualification on October 5:

- Windows Node 24.13.0 / npm 11.6.2: fresh `ci --ignore-scripts`, installed `ls --all`, and audit passed; zero advisories. This does not claim native Windows SDK support.
- Disposable Linux x64 containers, Node 24.20.0, independently fresh npm 10.9.4 and 11.6.2 installs: **262 packages** each, full installed `ls --all` passed, audit reported **zero advisories**, and manifest/lock hashes were unchanged.
- Each Linux installed tree passed actual ESM Dynamic SDK, viem/chains, WalletConnect ESM/CommonJS, axios, uuid and ws imports with `--network none`. The probe verified the required SDK method exports and used only an injected local axios adapter. It also imported the real authorization and action modules without invoking them. No SDK client was instantiated, authentication performed, wallet obtained, RPC called, signature generated or transaction broadcast.
- Public-source Git archive tree `474492b5486e6b004b00829f89c451d0bc145d72`, archive SHA256 `001f812e1306e0fdf3d959154c8794d36de585d855f6ec3bbeafc4e50f6fc683`; disposable lab `risk-fork-dynamic.D7WPIaSh` returned exit 0 and verified cleanup. This pre-documentation tree binds the tested manifest/lock/source bytes; final-head review and hosted CI evidence belong to PR #414.

The lab retained three setup failures separately: a probe selected the SDK's CommonJS target instead of the runtime's ESM import condition; a nested mount could not create a file beneath a read-only mount; and the first archive omitted the authorization module's local caller dependencies. The final run corrected these test-harness defects without changing the runtime or suppressing assertions. No provider failure or provider qualification is inferred from them. A separate mismatched-archive-hash invocation failed before allocating any lab container.

Lifecycle scripts remained disabled. Import checks do not exercise native cryptographic initialization or signing. macOS, Linux arm64 and other Node/runtime combinations were not qualified by this lab. Deprecated transitive-package warnings remain distinct from the time-specific zero-advisory audit result.

The branded static workbench, presentation, offline export and responsive checks are tested separately. Browser QA covers controlled scenarios, text-only rendering of results, mode labels, keyboard presentation controls and viewport overflow. It does not establish Firefox/Safari, real screen-reader behavior, judge comprehension, or a public deployment.

## CI integration

The existing `risk-fork/package.json` wildcard `node --test test/*.test.mjs` discovers the example, reference, brand and lock-metadata tests. No additional workflow or workflow-scope token is needed for these tests in this repository. Hosted Risk Fork CI does not install or audit the nested `live/` package: the clean installs and network-disabled imports above are separately observed local-container evidence, not hosted CI. This does not close the separate workflow-edit gate on the old Dynamic/DFNS spikes in `agent-marketplace`.

## Explicitly unqualified

- Native cryptographic initialization/signing and untested supported OS/runtime combinations. The clean npm 10/11 dependency trees and credential-free Linux x64 imports above do not establish those behaviors.
- Dynamic account, wallet creation, signing, broadcasting or testnet confirmations.
- Provider policy enforcement or transaction simulation.
- Production OS isolation, arbitrary untrusted code execution, hosted multi-tenant execution or real customer data.
- Hackathon eligibility: testnet acceptance, pre-existing-code allowance, deterministic-agent acceptance, submission deadline and required presentation assets.

The web page never loads the Dynamic SDK or exposes a wallet endpoint. Only static public files may be deployed. The local reference is not a production isolation boundary. A successful wallet signature would not by itself prove delivery or settlement.

## Branded follow-up local checks

Four branding/public-boundary tests passed locally with zero skips. Chromium/Playwright exercised all six scenario states and all four presenter presets, checked exported evidence retains `dynamic_contacted:false` and `risk_fork_executed:false` in browser mode, and found no horizontal overflow at 320, 390, 768 and 1440 pixels. No page-script errors were observed. The eight-slide deck exported to eight PDF pages and every page was visually inspected. End-key navigation reached the final slide; actual browser fullscreen, Safari/Firefox and screen readers were not tested. The presenter guide also fit 390 and 1440 pixel widths. These checks used locally rendered standalone HTML, not a public deployment.
