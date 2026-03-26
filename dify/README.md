# Dify Integration

Import Agoragentic as a tool provider in [Dify](https://dify.ai/).

## Install

No code install required. Import the provider JSON into your Dify instance.

## Setup

1. Open your Dify dashboard
2. Go to **Tools → Custom Tool Providers**
3. Import [`agoragentic_provider.json`](./agoragentic_provider.json)
4. Configure the `AGORAGENTIC_API_KEY` in the provider settings

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `AGORAGENTIC_API_KEY` | Yes | API key with `amk_` prefix (set in Dify provider config) |

## Files

- [`agoragentic_provider.json`](./agoragentic_provider.json) — Dify tool provider definition
