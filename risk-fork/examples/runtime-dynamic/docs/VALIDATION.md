# Validation record — Runtime Dynamic example

This record distinguishes local tests, hosted evidence, and the still-unqualified wallet path. No independent human security audit or live provider test is claimed.

## Source and hosted evidence

Initial published source: `9603f2220fc6df8f54f2f8532552f991956a5266` on draft [PR #397](https://github.com/rhein1/agoragentic-integrations/pull/397).

[Risk Fork hosted run 34779683264](https://github.com/rhein1/agoragentic-integrations/actions/runs/34779683264), job `103784274246`, completed successfully: **697 passed, 1 skipped, 0 failed**. Logs include all three new tests of the actual local-reference runtime: accepted source with verified cleanup, rejected injected instruction with cleanup, and full source-selection preparation through the real reference adapter. The 27 agent/authorization tests also passed. The rest of the suite includes existing Risk Fork tests; this is not 697 newly written hackathon tests.

This is evidence for that source SHA only. The brand, presenter and documentation follow-up requires its own hosted run. Current exact-head evidence is recorded in the PR, not inferred from an earlier green run.

## Local validation

The initial dependency-free agent/authorization/SDK-wrapper suite passed **27/27** with injected SDK/RPC implementations. No actual Dynamic SDK install, credential use or network operation is established by that result.

The branded static workbench, presentation, offline export and responsive checks are tested separately. Browser QA covers controlled scenarios, text-only rendering of results, mode labels, keyboard presentation controls and viewport overflow. It does not establish Firefox/Safari, real screen-reader behavior, judge comprehension, or a public deployment.

## CI integration

The existing `risk-fork/package.json` wildcard `node --test test/*.test.mjs` discovers the example, reference and brand tests. No additional workflow or workflow-scope token is needed for these tests in this repository. This does not close the separate workflow-edit gate on the old Dynamic/DFNS spikes in `agent-marketplace`.

## Explicitly unqualified

- Actual Dynamic SDK/native dependencies and reviewed live lockfile.
- Dynamic account, wallet creation, signing, broadcasting or testnet confirmations.
- Provider policy enforcement or transaction simulation.
- Production OS isolation, arbitrary untrusted code execution, hosted multi-tenant execution or real customer data.
- Hackathon eligibility: testnet acceptance, pre-existing-code allowance, deterministic-agent acceptance, submission deadline and required presentation assets.

The web page never loads the Dynamic SDK or exposes a wallet endpoint. Only static public files may be deployed. The local reference is not a production isolation boundary. A successful wallet signature would not by itself prove delivery or settlement.

## Branded follow-up local checks

Four branding/public-boundary tests passed locally with zero skips. Chromium/Playwright exercised all six scenario states and all four presenter presets, checked exported evidence retains `dynamic_contacted:false` and `risk_fork_executed:false` in browser mode, and found no horizontal overflow at 320, 390, 768 and 1440 pixels. No page-script errors were observed. The eight-slide deck exported to eight PDF pages and every page was visually inspected. End-key navigation reached the final slide; actual browser fullscreen, Safari/Firefox and screen readers were not tested. The presenter guide also fit 390 and 1440 pixel widths. These checks used locally rendered standalone HTML, not a public deployment.
