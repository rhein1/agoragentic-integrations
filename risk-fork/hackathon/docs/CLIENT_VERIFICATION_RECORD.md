# Client verification record

Use one record per exact Risk Fork artifact, client version, operating system, and configuration. Never convert an unobserved client into `verified` because a template was generated or the minimal stdio probe passed.

## Status vocabulary

- `verified` — the named client visibly discovered all four served demo tools, completed the stated scenario, returned a receipt, and cleanup was verified.
- `failed` — the named test was attempted and did not meet the record's assertions.
- `unknown_not_tested` — no controlled observation exists.
- `not_applicable` — the field cannot apply, with an explanation.

## Required JSON shape

```json
{
  "schema": "agoragentic.risk-fork.client-verification-record.v1",
  "recorded_at": "2026-09-04T00:00:00.000Z",
  "source_commit": "40-lowercase-hex-characters",
  "zip_sha256": "64-lowercase-hex-characters",
  "platform": "win32|darwin|linux",
  "architecture": "x64|arm64|other-observed-value",
  "node_version": "v22.x.x",
  "client": {
    "name": "exact client name",
    "version": "exact observed version",
    "transport": "stdio_json_rpc",
    "status": "verified|failed|unknown_not_tested|not_applicable"
  },
  "configuration": {
    "source": "generated_then_reviewed|manual_reviewed|not_configured",
    "destination_ref": "redacted non-secret reference",
    "user_approved_mutation": false,
    "credentials_included": false
  },
  "assertions": {
    "initialize": "verified|failed|unknown_not_tested",
    "four_tool_inventory": "verified|failed|unknown_not_tested",
    "plan": "verified|failed|unknown_not_tested",
    "run": "verified|failed|unknown_not_tested",
    "receipt": "verified|failed|unknown_not_tested",
    "cleanup": "verified|failed|unknown_not_tested"
  },
  "scenario": "high-filesystem-write",
  "provider_calls": 0,
  "network_used": false,
  "live_traffic_protected": false,
  "absolute_paths_included": false,
  "notes": "Observed facts and exact failure text, with secrets removed."
}
```

The automated `verify-release-artifacts.mjs` record uses `minimal_protocol_conformance_probe` as its client and leaves Codex, Claude Desktop, and Cursor at `unknown_not_tested`. For a GUI test, create a separate record; do not edit the automated record into a different claim.

## Evidence checklist

- Preserve the exact ZIP checksum and source commit.
- Record the client and Node versions from the machine used.
- Capture the exact four tool names, not only a connection indicator.
- Exercise a plan, a fixed synthetic run, receipt lookup, and cleanup.
- Confirm `provider_calls: 0`, `network_used: false`, and `live_traffic_protected: false` for this offline kit.
- Exclude credentials, raw prompts, raw tool output, absolute local paths, and participant identity.
- Store the record beside test evidence; do not treat it as authority to publish or deploy.
