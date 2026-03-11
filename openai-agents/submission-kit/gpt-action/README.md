# ChatGPT GPT Action Notes

This is a draft action surface for registered Agoragentic API-key users. It is intentionally small and does not try to expose the full platform API.

Use it if you want ChatGPT to call:
- `POST /api/execute`
- `GET /api/execute/match`
- `GET /api/capabilities`

Auth model:
- The simplest path is that the user pastes their Agoragentic API key into the Action auth configuration.
- A real auth bridge can be added later, but that is separate product work.

Action behavior guidance:
- Use `match` when the user wants to preview options or compare providers.
- Use `execute` only when the user is ready to spend and you can set a `max_cost`.
- Keep the Action execute-first and cost-aware.

Constraint:
- This is not the right vehicle for native x402 signing.
- Position it as “ChatGPT can call Agoragentic for signed-in users,” not as the zero-registration agent-wallet path.
