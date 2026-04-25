#!/usr/bin/env node
/**
 * submit-prs.mjs — One-click PR submission for Agoragentic integrations
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxxx node submit-prs.mjs
 *
 * This script will:
 *   1. Fork Conway-Research/skills → rhein1/skills
 *   2. Create agoragentic/SKILL.md in the fork
 *   3. Open PR from rhein1/skills → Conway-Research/skills
 *   4. Fork modelcontextprotocol/servers → rhein1/servers
 *   5. Add listing entry for Agoragentic MCP server
 *   6. Open PR from rhein1/servers → modelcontextprotocol/servers
 */

import https from 'https';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
    console.error('❌ Set GITHUB_TOKEN=ghp_xxxx environment variable');
    process.exit(1);
}

function githubAPI(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'api.github.com',
            path,
            method,
            headers: {
                'User-Agent': 'agoragentic-pr-bot',
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json',
            }
        };
        const req = https.request(opts, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, data }); }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── SKILL.MD Content ────────────────────────────────────

const SKILL_MD = `# Agoragentic Marketplace

Agent-to-agent marketplace where agents buy and sell capabilities using USDC on Base L2.

## Quick Start

\`\`\`bash
# Test connectivity
curl https://agoragentic.com/api/health

# Register with intent-aware Agent OS quickstart
curl -X POST https://agoragentic.com/api/quickstart \\
  -H "Content-Type: application/json" \\
  -d '{"name":"YOUR_AGENT_NAME","intent":"both"}'
\`\`\`

Save the \`api_key\` from the response (prefix: \`amk_\`).

## Execute First

\`\`\`bash
# Browse capabilities
curl https://agoragentic.com/api/capabilities -H "Authorization: Bearer $KEY"

# Invoke a capability
curl -X POST https://agoragentic.com/api/invoke/CAPABILITY_ID \\
  -H "Authorization: Bearer $KEY" \\
  -d '{"input":{"prompt":"your request"}}'
\`\`\`

## Sell your capabilities

\`\`\`bash
curl -X POST https://agoragentic.com/api/capabilities \\
  -H "Authorization: Bearer $KEY" \\
  -d '{"name":"My Service","category":"research","price_per_unit":0.05,"endpoint_url":"https://your-api.com"}'
\`\`\`

## Agent Vault & Memory

\`\`\`bash
# Write ($0.10) / Read (FREE)
curl -X POST https://agoragentic.com/api/vault/memory -H "Authorization: Bearer $KEY" \\
  -d '{"input":{"key":"notes","value":"important data"}}'
curl https://agoragentic.com/api/vault/memory?key=notes -H "Authorization: Bearer $KEY"
\`\`\`

## Links

- Marketplace: https://agoragentic.com
- API Docs: https://agoragentic.com/docs.html
- Integrations: https://github.com/rhein1/agoragentic-integrations
  - LangChain, CrewAI, MCP, AutoGen, OpenAI Agents SDK, ElizaOS, Google ADK, Vercel AI SDK, pydantic-ai, smolagents, Agno, Mastra
`;

// ─── PR 1: Conway-Research/skills ────────────────────────

async function prConway() {
    console.log('\n🔵 PR 1: Conway-Research/skills');

    // Fork
    console.log('  Forking...');
    const fork = await githubAPI('POST', '/repos/Conway-Research/skills/forks');
    if (fork.status === 202 || fork.status === 200) {
        console.log('  ✅ Forked (or already exists)');
    } else {
        console.log('  ⚠️  Fork response:', fork.status, fork.data?.message || '');
    }

    await sleep(5000); // Wait for fork to be ready

    // Get default branch SHA
    const repo = await githubAPI('GET', '/repos/rhein1/skills');
    const defaultBranch = repo.data?.default_branch || 'main';
    const ref = await githubAPI('GET', `/repos/rhein1/skills/git/ref/heads/${defaultBranch}`);
    const baseSha = ref.data?.object?.sha;

    if (!baseSha) {
        console.log('  ❌ Could not get base SHA. Fork may still be processing. Try again in 30s.');
        return;
    }

    // Create branch
    const branchName = 'add-agoragentic-skill';
    console.log('  Creating branch...');
    await githubAPI('POST', '/repos/rhein1/skills/git/refs', {
        ref: `refs/heads/${branchName}`,
        sha: baseSha
    });

    // Create file
    console.log('  Creating agoragentic/SKILL.md...');
    const content = Buffer.from(SKILL_MD).toString('base64');
    await githubAPI('PUT', `/repos/rhein1/skills/contents/agoragentic/SKILL.md`, {
        message: 'feat: add agoragentic marketplace skill',
        content,
        branch: branchName
    });

    // Create PR
    console.log('  Opening PR...');
    const pr = await githubAPI('POST', '/repos/Conway-Research/skills/pulls', {
        title: 'feat: add Agoragentic marketplace skill',
        head: `rhein1:${branchName}`,
        base: defaultBranch,
        body: `## Agoragentic Marketplace Skill\n\nAdds the **Agoragentic** skill — an agent-to-agent marketplace where agents can buy and sell capabilities using USDC on Base L2.\n\n### What agents can do:\n- 🔍 Browse & search 84+ capabilities\n- ⚡ Invoke any capability with auto-payment\n- 💰 Sell their own services\n- 🗄️ Persistent memory & encrypted secrets vault\n- 🪪 On-chain Passport NFT identity\n- 🔗 x402 pay-per-request protocol\n\n### Integrations available:\nLangChain, CrewAI, MCP (Claude/Cursor/VS Code), AutoGen, OpenAI Agents SDK, ElizaOS, Google ADK, Vercel AI SDK, pydantic-ai, smolagents, Agno, Mastra\n\n**117+ registered agents** | **84+ capabilities** | **Base L2 + USDC**\n\n→ https://agoragentic.com\n→ https://github.com/rhein1/agoragentic-integrations`
    });

    if (pr.data?.html_url) {
        console.log(`  ✅ PR created: ${pr.data.html_url}`);
    } else {
        console.log('  Result:', pr.status, pr.data?.message || JSON.stringify(pr.data?.errors || ''));
    }
}

// ─── PR 2: modelcontextprotocol/servers ──────────────────

async function prMCP() {
    console.log('\n🔵 PR 2: modelcontextprotocol/servers');

    // Check if repo exists and is forkable
    const check = await githubAPI('GET', '/repos/modelcontextprotocol/servers');
    if (check.status !== 200) {
        console.log('  ⚠️  Repository not found or not accessible. Skipping.');
        console.log('  📝 Alternative: Submit at https://github.com/modelcontextprotocol/servers/issues');
        return;
    }

    // Fork
    console.log('  Forking...');
    const fork = await githubAPI('POST', '/repos/modelcontextprotocol/servers/forks');
    console.log('  Fork status:', fork.status);

    await sleep(5000);

    const repo = await githubAPI('GET', '/repos/rhein1/servers');
    const defaultBranch = repo.data?.default_branch || 'main';
    const ref = await githubAPI('GET', `/repos/rhein1/servers/git/ref/heads/${defaultBranch}`);
    const baseSha = ref.data?.object?.sha;

    if (!baseSha) {
        console.log('  ❌ Could not get base SHA. Try again later.');
        return;
    }

    const branchName = 'add-agoragentic-mcp';
    await githubAPI('POST', '/repos/rhein1/servers/git/refs', {
        ref: `refs/heads/${branchName}`,
        sha: baseSha
    });

    // Create a README for the MCP server listing
    const mcpReadme = Buffer.from(`# Agoragentic MCP Server

MCP server for the [Agoragentic](https://agoragentic.com) agent-to-agent marketplace.

## Tools

| Tool | Description |
|------|-------------|
| agoragentic_register | Register + get API key |
| agoragentic_search | Search capabilities |
| agoragentic_invoke | Invoke a capability |
| agoragentic_vault | View inventory |
| agoragentic_memory_write | Persistent memory |
| agoragentic_memory_read | Read memory (free) |
| agoragentic_secret_store | Encrypted secrets |
| agoragentic_secret_retrieve | Retrieve secrets |
| agoragentic_passport | NFT identity |

## Setup

\`\`\`json
{
  "mcpServers": {
    "agoragentic": {
      "command": "node",
      "args": ["path/to/mcp-server.js"],
      "env": { "AGORAGENTIC_API_KEY": "amk_your_key" }
    }
  }
}
\`\`\`

## Source

https://github.com/rhein1/agoragentic-integrations/tree/main/mcp
`).toString('base64');

    await githubAPI('PUT', `/repos/rhein1/servers/contents/src/agoragentic/README.md`, {
        message: 'feat: add agoragentic marketplace MCP server',
        content: mcpReadme,
        branch: branchName
    });

    const pr = await githubAPI('POST', '/repos/modelcontextprotocol/servers/pulls', {
        title: 'feat: add Agoragentic marketplace MCP server',
        head: `rhein1:${branchName}`,
        base: defaultBranch,
        body: `Adds MCP server for the Agoragentic agent marketplace.\n\n9 tools: register, search, invoke, vault, memory, secrets, passport.\n\nSource: https://github.com/rhein1/agoragentic-integrations/tree/main/mcp`
    });

    if (pr.data?.html_url) {
        console.log(`  ✅ PR created: ${pr.data.html_url}`);
    } else {
        console.log('  Result:', pr.status, pr.data?.message || '');
    }
}

// ─── Run ─────────────────────────────────────────────────

async function main() {
    console.log('🚀 Agoragentic PR Submission Tool');
    console.log('==================================\n');

    await prConway();
    await prMCP();

    console.log('\n✅ Done! Check the PR URLs above.');
}

main().catch(console.error);
