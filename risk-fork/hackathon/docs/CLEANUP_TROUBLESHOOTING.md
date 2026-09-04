# Risk Fork Hackathon Demo: Cleanup and Troubleshooting

> **DEMO ONLY — LOCAL PROTOCOL SIMULATOR — NOT AN ISOLATION BOUNDARY — NO LIVE PROTECTION**

Runtime data is local and disposable, but deletion is never inferred from a
success message alone. The demo requests destruction and then records a separate
absence observation. `unknown` and `failed` are not successful cleanup states.

## Safe cleanup

1. Disconnect the agent client from the local connector.
2. Stop the Flight Recorder and any active demo command.
3. Inspect the marker-bound owned root reference without changing it:

   ```powershell
   node risk-fork/hackathon/bin/risk-fork-demo.mjs doctor
   ```

4. Request marker-bound cleanup:

   ```powershell
   node risk-fork/hackathon/bin/risk-fork-demo.mjs cleanup
   ```

5. Require a separately verified absence result for both fork and savepoint
   resources. A nonzero exit or `unknown`/`failed` result requires investigation.

The cleanup command must refuse an unresolved path, missing/mismatched ownership
marker, broad temporary directory, home directory, repository root, participant
workspace, symlink/reparse escape, or anything outside the exact owned demo root.
Do not work around that refusal with a broad recursive-delete command.

## Automatic cleanup boundary

Whenever a savepoint or fork was allocated, the demo requests cleanup on
success, error, timeout, interruption, and shutdown. LOW/direct and DENY paths
allocate no savepoint or fork and make zero adapter calls; their savepoint/fork
cleanup fields explicitly report `cleanup.requested=false`,
`cleanup.absence=not_applicable`, `cleanup.status=not_applicable`, and
`savepoint_status=not_allocated`. A temporary owned run bookkeeping workspace
may still be created, and its removal is independently reported by
`owned_run_cleanup` (normally `verified_absent`). A process crash may leave an
owned fixture for the next bounded cleanup pass. The ownership ledger is for
demo recovery; it is not provider inventory or a production deletion service.

Each active run holds one exact, size-bounded JSON lock containing the owned
root ID, unique lock and run IDs, owner PID, creation time, and an integrity
hash. `cleanup` first takes a separate root-bound exclusive recovery lock. It
will not recover the active lock unless the owner is deterministically observed
dead and the lock is at least 30 seconds old. A live owner, indeterminate
liveness result, young lock, malformed JSON, root mismatch, integrity mismatch,
or concurrent lock change returns nonzero with cleanup `unknown` and preserves
the active evidence.

For an eligible crash lock, cleanup re-reads and hash-matches the same bytes,
atomically renames that exact lock into a unique marker-bound quarantine entry,
and removes only its matching owned run plus the known local fork, savepoint,
recorder, state, and generated-configuration artifacts through the owned-root
cleanup helpers. It then verifies active-lock, run, fork, savepoint, quarantine,
and recovery-lock absence separately. Any mismatch or race remains nonzero and
`unknown`; retry only after the reported live/young condition has cleared. Never
delete or edit either lock manually to force recovery.

The Git repository stores public draft source, not runtime forks. Generated kits
remain local until a separate publication action is authorized. Runtime fixture
bytes, recorder history, and local receipts stay beneath the owned demo root on
the participant's machine. They are not stored in GitHub, E2B, AWS,
Agoragentic, a VM, or a hosted database.

## Common failures

### Unsupported Node version

Use Node.js 20 or newer. Run `doctor` again after selecting the supported local
Node executable. Do not substitute a registry package runner.

### Configuration was only printed

`config --client <client>` is intentionally read-only. Review its exact target
and local Node command, then rerun with `--yes` only if you approve the write.
Restart the client if that client loads MCP configuration only at startup.

### Configuration is not client-verified

`generated_not_client_verified` means the shape was generated but the exact
client/version has no independent runtime evidence. Use generic stdio or inspect
the client's current local MCP documentation. Do not reinterpret generation as
successful connection evidence.

### Flight Recorder does not open

Use only the printed `127.0.0.1` URL and its current token. The operating system
chooses the port, so an old URL is stale. The page intentionally rejects remote
origins, missing tokens, and external assets.

### Run limit reached

The defaults permit one active run and ten completed runs between explicit
cleanup resets; there is no once-per-day quota. Finish or stop the active run,
inspect its cleanup result, and use the bounded cleanup/reset path. Do not remove
the ledger manually.

### Workspace, action, write, recorder, or root limit reached

The request is rejected rather than truncating a security-relevant input. The
defaults are 128 fixture files/4 MiB per workspace, 256 KiB per synthetic write,
50 actions, 4 MiB recorder history, and 64 MiB for the owned root. Use a smaller
included fixture; do not point the demo at participant data.

### Execution timeout or interruption

The execution timeout is 10 seconds and the fork TTL is 60 seconds. Wait for the
cleanup report. If it is not verified, rerun `cleanup`; never claim the resource
absent from timeout or process exit alone.

### Cleanup is unknown or failed

Preserve the sanitized receipt, run identifier, redacted owned-root reference,
ownership marker status, and cleanup evidence. Rerun `doctor`, then `cleanup`.
For `DEMO_ACTIVE_LOCK_LIVE`, stop the owning demo process normally. For
`DEMO_ACTIVE_LOCK_YOUNG`, wait until the fixed 30-second grace period has passed.
Malformed, mismatched, raced, indeterminate-owner, recovery-lock, or quarantine
errors are fail-closed: stop using the demo root and preserve the bounded local
evidence. Do not claim deletion, alter the lock bytes, or broaden the cleanup
target.

### Offline-kit verification fails

Do not run the kit. Re-extract it into a fresh directory and rerun:

```powershell
node risk-fork/hackathon/bin/risk-fork-demo.mjs verify-offline-kit
```

A hash, size, source-commit, path, Node-version, representative-scenario,
receipt, recorder, or cleanup mismatch is terminal for that kit. Obtain a newly
verified commit-pinned artifact; do not repair extracted bytes in place.

## Information safe to report

- Demo version and exact source commit from the kit manifest.
- Named fixture ID and deterministic risk level.
- Sanitized lifecycle, receipt hash, and cleanup state.
- Node version and operating-system family.
- Exact local error code with secrets and private paths removed.

Never report API keys, tokens, wallet material, authorization headers, private
repository content, participant workspace content, raw prompts, or raw tool
output.

Local cleanup evidence supports only this owned protocol-simulator fixture. It
does not prove an E2B deletion SLA, cloud containment, hosted protection, or
production readiness.
