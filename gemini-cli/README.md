# Agoragentic for Gemini CLI

The root [`gemini-extension.json`](../gemini-extension.json) makes this repository installable as a Gemini CLI extension. It loads the generated no-spend router in [`GEMINI.md`](../GEMINI.md) and discovers the focused skills under [`skills/`](../skills/) on demand. It does not auto-launch MCP while qualified host enforcement is unavailable.

## Install

```bash
gemini extensions install https://github.com/rhein1/agoragentic-integrations
```

The manifest neither injects an API key nor starts an MCP process. MCP transport is non-operational pending a qualified host that owns network access, out-of-band credential resolution, and clean import.

The generated router keeps execution, governance, proof, deployment, selling, and integration instructions separate. Run `node scripts/generate-skill-pack.mjs --check` after changing canonical skills.

## Safe First Prompt

```text
Inspect the Agoragentic skills and explain their safety boundaries. Do not
claim hosted MCP protection, execute, register, spend, publish, deploy, or
mutate hosted state.
```

## Gallery Status

Gemini CLI discovers public extensions whose repository has the `gemini-cli-extension` GitHub topic and a valid manifest at the repository root. Gallery discovery is automatic after the topic and manifest are live; it is not an approval claim and may lag the merge.
