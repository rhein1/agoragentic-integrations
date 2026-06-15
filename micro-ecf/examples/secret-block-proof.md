# Micro ECF Secret Block Proof

This example shows the expected shape of a Micro ECF scan when a local project contains both allowed docs and a blocked `.env` file.

## Source Map Excerpt

```json
{
  "sources": [
    {
      "source_id": "docs:README.md",
      "path": "README.md",
      "status": "allowed",
      "citation": "source-map.json:sources[0]"
    },
    {
      "source_id": "blocked:.env",
      "path": ".env",
      "status": "blocked",
      "reason": "secret-like env file",
      "raw_content_exported": false,
      "citation": "source-map.json:blocked_sources[0]"
    }
  ]
}
```

## Context Packet Excerpt

```json
{
  "claims": [
    {
      "claim": "The project README is allowed context.",
      "source_id": "docs:README.md",
      "citation": "source-map.json:sources[0]"
    }
  ],
  "blocked_sources": [
    {
      "path": ".env",
      "reason": "secret-like env file",
      "raw_content_exported": false,
      "citation": "source-map.json:blocked_sources[0]"
    }
  ]
}
```

Micro ECF may record that `.env` exists and why it was blocked. It must not export the raw `.env` contents into context packets, Harness exports, Agent OS preview artifacts, or MCP responses.
