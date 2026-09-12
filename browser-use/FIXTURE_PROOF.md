# Browser Proof fixture contract

This is a test harness in the existing browser integration, not a general executor, receipt service, website scanner, or production Browser Use adapter.

## Required observations

At widths 375, 768 and 1280, the fixed synthetic page must show the expected heading, navigate to its evidence anchor, and avoid horizontal overflow. Screenshots are capped at 1 MiB each. Their bytes, the HTML fixture, the launched executable copy and its adjacent resource bundle are SHA-256 identified.

Every actual context request is routed to `abort_external`. Page content comes from the bundled constant, never a caller URL or HTML file. The fixed `.invalid` navigation must reach and be aborted by the interceptor. Failure before interception remains blocked, not passed. Do not change administrator policy to make the fixture green.

## Runtime integrity and launch binding

The default qualification target is **CPython 3.12.10, Ubuntu 24.04 / Linux x86_64, Playwright 1.57.0, Chromium 143.0.7499.4 / build 1200**. `requirements-proof.txt` pins Playwright and all three transitive Python distributions to exact versions and wheel hashes. CI installs them in a fresh virtual environment with `--require-hashes --only-binary=:all:`. Other interpreter/platform wheel sets require a separately reviewed lock; there is no unpinned fallback.

`browser-runtime-lock.json` pins the executable and the complete 305-file browser resource tree. Its provenance links to the SHA-bound qualification run that obtained the upstream wheels/browser bytes. Those observed downloads establish the reviewed content baseline, not publisher-signature verification. The lock is committed before the enforcement run; it is never generated from each incoming download and then accepted as its own proof.

Before launch, `prepare_browser` copies bounded, descriptor-verified regular files into a newly allocated private directory. It hashes the same bytes it copies, compares the committed bundle pin, removes write permissions, and checks file identities and digests before and after launch and after the fixture. The original installation path is not launched. Replacing that original path after staging cannot substitute the selected executable. Changed resources, copied-file identities, writable copies and digest mismatches fail closed. Temporary copies are removed after browser cleanup, with an explicit `runtime_copy_removed` result.

The copy is read-only and runner-owned, not kernel-sealed against privileged or same-user malicious code. Parent/process ownership remains a host assumption. This is not a system-image lock: OS libraries, fonts, kernel, Python distributor provenance and installation-tool internals are outside the committed browser/Python-package hash scope. No OS isolation, native network absence, process-memory attestation or production security claim is made.

Custom executable selection still requires its explicit SHA-256 and now stages the executable's containing distribution directory under the same bounds. Select a dedicated browser distribution, not a shared bin/project/home directory. A custom executable digest does not grant the default complete-bundle qualification; reports keep `bundle_integrity_locked:false` for that mode. Browser downloads happen only in explicit setup, never as a runtime repair.

## Cancellation and cleanup

The owner-controlled cancellation event races the active fixture task. Outstanding work is cancelled and awaited before the browser connection closes. `--cancel-before-work` exercises pre-work cancellation and returns exit 2 with zero cases. `--cancel-after-first-case` signals after the first screenshot while the worker remains active; it returns exit 2 with exactly one case and `cancellation_stage:after_first_screenshot`. Both paths are exercised by current workflow code, not merely described as manual probes.

`browser_connection_closed` measures Playwright connection state, not independent OS-child termination. `process_exit_independently_verified` remains false. A passing fixture also requires successful test-owned runtime-copy cleanup. Existing output files and normal browser profiles are never overwritten or removed. Failed runs can retain their new partial report/screenshot artifacts for review.

## Validation

```sh
python -m unittest discover -s browser-use -p test_fixture_proof.py
python browser-use/fixture_proof.py /path/to/new-output-directory
python browser-use/fixture_proof.py /path/to/another-new-directory --cancel-after-first-case
```

The original boundary suite contained seven tests, not six. The review corrections add eight: private-copy replacement/tamper checks, resource-tree pinning, descriptor identity, an end-to-end launch-boundary test double, active cancellation, lock completeness and dependency drift. All **15 provider/browser-free tests** passed locally. Those fake-driver tests do not prove real browser behavior; the real Chromium, hash-enforced setup, three viewport checks and both cancellation modes require current-head CI evidence.

Historical local Chromium 144 observations, including an administrator-blocked route probe, remain historical only. No Browser Use process, provider, model, public website, customer session, wallet or settlement path is exercised by this fixture.

## Next implementation gate

Reconcile the private Browser Use runner's actual review findings. Separately qualify Browser Use process admission, the OS runtime, current action authority, revocation, independent process cleanup and consequential actions. Synthetic layout checks do not close `rhein1/agent-marketplace#1297` or `#1301`, and this change activates neither.
