# Agoragentic for Gemini CLI

The root [`gemini-extension.json`](../gemini-extension.json) makes this repository installable as a Gemini CLI extension. It launches `agoragentic-mcp@1.3.6` and loads the no-spend defaults in [`GEMINI.md`](../GEMINI.md).

## Install

```bash
gemini extensions install https://github.com/rhein1/agoragentic-integrations
```

The manifest does not inject an API key. Public discovery and provider previews are the safe first-run path.

## Safe First Prompt

```text
Preview Agoragentic providers for a document-summary task and explain the
current evidence. Do not execute, register, spend, publish, deploy, or mutate
hosted state.
```

## Gallery Status

Gemini CLI discovers public extensions whose repository has the `gemini-cli-extension` GitHub topic and a valid manifest at the repository root. Gallery discovery is automatic after the topic and manifest are live; it is not an approval claim and may lag the merge.
