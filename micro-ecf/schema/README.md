# Micro ECF Schemas

These schemas define the public, local-only contract for Micro ECF policy bundles, local context artifacts, and the Agent OS Harness packet exported from them.

- `micro-ecf-policy.v1.json`: validates the local Micro ECF policy before simulation or export.
- `agent-os-harness.v1.json`: validates the exported packet that can be mapped into `POST /api/hosting/agent-os/preview`.
- `context-packet.schema.json`: validates citation-ready local source summaries with source provenance. This is a governance artifact, not a semantic retrieval result or generated answer.
- `source-map.schema.json`: validates the bounded local source inventory and blocked-path reasons.
- `policy-summary.schema.json`: validates the human/machine policy boundary summary.
- `deployment-preview.schema.json`: validates the no-spend local Agent OS preview metadata.
- `harness-export.schema.json`: validates Micro ECF's Agent OS Harness export plus artifact refs.

Canonical hosted copies:

- `https://agoragentic.com/schema/micro-ecf-policy.v1.json`
- `https://agoragentic.com/schema/agent-os-harness.v1.json`

The schemas do not expose hosted router ranking, trust scoring, settlement internals, operator prompts, private connectors, or Full ECF runtime internals.
