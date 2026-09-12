# Browser Proof fixture contract

This is a test harness in the existing browser integration, not a general executor, receipt service, website scanner, or production Browser Use adapter.

## Required observations

At each width 375, 768 and 1280, the fixed synthetic page must show the expected heading, navigate to its evidence anchor, and avoid horizontal overflow. Screenshots are capped at 1 MiB each. Their exact bytes, the HTML fixture and the selected browser executable are SHA-256 identified; the Playwright and browser versions are recorded.

All actual context requests are routed to `abort_external`. The content is inserted from the bundled Python constant, not loaded from disk URLs or remote sources. One fixed `.invalid` navigation tests whether that interceptor actually ran. A failed navigation alone is insufficient: missing observed interception produces `blocked` with `route_boundary_not_exercised` even when all three UI cases passed.

Playwright contexts, offline mode, disabled page JavaScript and request interception are not OS network isolation. The browser driver may use its normal process defaults; this fixture does not claim a Linux sandbox or an independently verified absence of native/background network activity. It must not be expanded to hostile arbitrary documents, authenticated sessions or consequential actions without the existing Agent OS runtime security gates.

## Cancellation and cleanup

The Python API accepts an owner-controlled `asyncio.Event`; it races the active fixture work against cancellation and cancels/awaits outstanding work before closing the browser connection. The CLI's `--cancel-before-work` exercises only pre-work cancellation and returns exit 2, never a successful fixture result.

`browser_connection_closed` reports the Playwright connection state after close. It does not prove every operating-system child process exited; `process_exit_independently_verified` stays false. Missing cleanup evidence prevents a passing result. No process signaling, profile deletion or directory deletion outside the test-owned paths is performed by the runner. A failed run can retain its new partial artifacts for review; existing directories/files are not overwritten.

## Measured local evidence, September 12

Using Playwright 1.57.0 and an explicitly selected installed Chromium 144.0.7559.96 binary (SHA-256 `2874aa85f9114065526e9d0912dcf668de44e90a2d2f04bb4e38108131a073bf`):

- six provider/browser-free unit tests passed;
- all three real browser viewport/heading/anchor/overflow cases passed;
- the browser connection closed;
- browser administrator policy rejected the fixed external navigation before the route interceptor received it, so the overall run correctly remained blocked;
- a pre-work cancellation run returned cancelled with no cases and a closed connection;
- a separate active-cancellation test signalled after the first screenshot and returned cancelled with one completed case and a closed connection.

The final environment-minimization follow-up reran the unit suite and three-viewport browser run with the same blocked boundary outcome. The active-cancellation observation preceded that follow-up and is not a latest-head rerun claim. The companion CI fixture checks current source with the installed pinned Playwright bundle and separately checks pre-work cancellation. It must pass without disabling administrator restrictions or weakening assertions.

No Browser Use process, provider, model, real website, customer session, wallet or settlement path was exercised. The output deliberately keeps those claims false. This is not evidence that private runner #1301 is ready to merge or activate.

## Next implementation handoff

Reconcile the current private Browser Use runner and its actual review findings. Use this fixture as a reproducible acceptance target, then separately bind the exact Browser Use artifact and OS-level runtime, current action authority, cancellation/revocation and independent process cleanup. Do not replace that work with another broad browser API or infer production readiness from synthetic layout checks.
