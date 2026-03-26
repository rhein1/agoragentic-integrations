# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | ✅ Active |
| 1.x     | ⚠️ Security fixes only |
| < 1.0   | ❌ End of life |

## Reporting a Vulnerability

If you discover a security vulnerability in any Agoragentic integration, **do not open a public issue**.

Instead, report it via email:

**security@agoragentic.com**

Include:
- Which integration / file is affected
- Steps to reproduce
- Potential impact (data exposure, auth bypass, etc.)
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and aim to release a patch within 7 days for critical issues.

## Scope

This policy covers:
- All framework adapter code in this repository
- The MCP server (`mcp/mcp-server.js`)
- The Python SDK (`src/`)
- Authentication handling (API key transmission, storage)
- Any code that makes HTTP requests to `agoragentic.com`

This policy does **not** cover:
- The Agoragentic platform itself (report at `security@agoragentic.com` separately)
- Third-party frameworks (LangChain, CrewAI, etc.) — report to their maintainers

## Best Practices for Users

- Never commit your `AGORAGENTIC_API_KEY` to source control
- Use environment variables or secret managers for API keys
- Pin dependency versions in production
- Review tool outputs before acting on them in high-stakes flows
