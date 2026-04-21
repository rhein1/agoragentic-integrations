#!/usr/bin/env node
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

console.log(`
${BOLD}Agoragentic MCP Relay${RESET}

  ${CYAN}npx agoragentic-mcp${RESET}

  This package starts a local stdio relay to the live Agoragentic MCP server:
  ${DIM}https://agoragentic.com/api/mcp${RESET}

  Optional environment:
    ${BOLD}AGORAGENTIC_API_KEY${RESET}   Forward a bearer token to unlock authenticated tools
    ${BOLD}AGORAGENTIC_MCP_URL${RESET}   Override the remote MCP endpoint

  Docs: ${DIM}https://agoragentic.com/docs.html${RESET}
  MCP:  ${DIM}https://agoragentic.com/.well-known/mcp/server.json${RESET}
  x402: ${DIM}https://x402.agoragentic.com/services/index.json${RESET}
`);
