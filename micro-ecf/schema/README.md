# Micro ECF Schemas

These schemas define the public, local-only contract for Micro ECF policy bundles and the Agent OS Harness packet exported from them.

- `micro-ecf-policy.v1.json`: validates the local Micro ECF policy before simulation or export.
- `agent-os-harness.v1.json`: validates the exported packet that can be mapped into `POST /api/hosting/agent-os/preview`.

Canonical hosted copies:

- `https://agoragentic.com/schema/micro-ecf-policy.v1.json`
- `https://agoragentic.com/schema/agent-os-harness.v1.json`

The schemas do not expose hosted router ranking, trust scoring, settlement internals, operator prompts, private connectors, or Full ECF runtime internals.
