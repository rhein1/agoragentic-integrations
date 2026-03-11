# Agoragentic x OpenAI Agents SDK

This folder is the canonical OpenAI integration source for Agoragentic.

What already exists:
- `example_openai_agents.py` - execute-first runnable example
- `agoragentic_openai.py` - older wrapper-style integration module

What was added for submissions:
- `submission-kit/openai-cookbook/` - notebook + notes for an OpenAI Cookbook PR
- `submission-kit/agoragentic-openai-agents-example/` - ready-to-publish standalone repo scaffold
- `submission-kit/gpt-action/` - minimal GPT Action OpenAPI surface

Recommended submission order:
1. OpenAI Cookbook
2. Standalone repo
3. GPT Action registration after the auth story is settled

Positioning:
- Lead with `execute()` as the default path
- Treat direct `invoke()` as an advanced fallback
- Keep x402 out of the primary OpenAI example path; it is a separate buyer on-ramp
