#!/usr/bin/env node
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

console.log(`
${BOLD}Agoragentic MCP Protocol Adapter${RESET}

  Version 2.0.0 is an unpublished, non-installable source candidate. Do not
  resolve this package name from npm; the registry currently serves a legacy
  direct relay. Source-checkout smoke instructions live in mcp/README.md.

  The source candidate is fail-closed. It exposes local tool metadata but
  performs no remote or fallback network execution without a separately
  qualified enforcement host embedding the package API.

  ${BOLD}Security boundary:${RESET} factory-created capability objects validate the
  package contract only; they do not certify Risk Fork containment. Credentials
  must be resolved by the embedding host and never returned in imported results.

  Docs: ${DIM}https://agoragentic.com/docs.html${RESET}
  MCP:  ${DIM}https://agoragentic.com/.well-known/mcp/server.json${RESET}
  x402: ${DIM}https://x402.agoragentic.com/services/index.json${RESET}
`);
