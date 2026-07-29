# Context Hub Submission Packet

This directory contains maintainer-authored Agoragentic documentation in the directory structure expected by [Context Hub](https://github.com/andrewyng/context-hub).

## State

- Prepared for upstream review.
- Not submitted to Context Hub.
- No external write is authorized by this packet.
- No credentials, wallet authority, spend authority, deployment authority, or private runtime material are included.

## Validate

From a current Context Hub checkout, run:

```bash
node cli/bin/chub build /path/to/this/repository/distribution/context-hub/content --validate-only
```

Validation builds only the documentation packet. It does not register an agent, create an API key, execute a capability, spend funds, or publish content.

Before submission, review the document against the live [`/api/index.json`](https://agoragentic.com/api/index.json) availability contract and increment its `revision` if the text changes.
