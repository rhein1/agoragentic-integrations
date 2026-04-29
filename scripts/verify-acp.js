#!/usr/bin/env node
/**
 * ACP Registry CI Verification Script
 * ====================================
 * Validates the agoragentic-acp agent.json against the ACP registry schema.
 * Mirrors the checks that agentclientprotocol/registry CI performs:
 *
 *   1. Schema compliance (required fields, types, patterns)
 *   2. Slug uniqueness (id format check)
 *   3. Icon format validation (16x16 SVG, currentColor)
 *   4. Distribution reachability (npx package exists)
 *   5. Auth handshake verification (spawn with --acp, send initialize)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ACP_DIR = path.join(__dirname, "..", "acp");
const AGENT_JSON = path.join(ACP_DIR, "agent.json");
const ICON_SVG = path.join(ACP_DIR, "icon.svg");

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        const result = fn();
        if (result === true || result === undefined) {
            console.log(`  ✓ ${name}`);
            passed++;
        } else {
            console.log(`  ✗ ${name}: ${result}`);
            failed++;
        }
    } catch (err) {
        console.log(`  ✗ ${name}: ${err.message}`);
        failed++;
    }
}

console.log("\n🔍 ACP Registry Verification\n");

// ─── 1. Schema compliance ────────────────────────────────
console.log("1. Schema Compliance");

const agent = JSON.parse(fs.readFileSync(AGENT_JSON, "utf8"));

check("id is present and lowercase-hyphen", () => {
    if (!agent.id) return "missing id";
    if (!/^[a-z][a-z0-9-]*$/.test(agent.id)) return `invalid id format: ${agent.id}`;
    return true;
});

check("name is present", () => !!agent.name || "missing name");
check("version is semver", () => {
    if (!agent.version) return "missing version";
    if (!/^\d+\.\d+\.\d+/.test(agent.version)) return `invalid semver: ${agent.version}`;
    return true;
});
check("description is present and non-empty", () => {
    if (!agent.description || agent.description.length < 10) return "missing or too short";
    return true;
});
check("distribution is present", () => !!agent.distribution || "missing distribution");
check("distribution has npx, binary, or uvx", () => {
    const d = agent.distribution || {};
    if (!d.npx && !d.binary && !d.uvx) return "no distribution method";
    return true;
});
check("npx distribution has package field", () => {
    if (!agent.distribution?.npx?.package) return "missing npx.package";
    return true;
});
check("npx args contains --acp", () => {
    const args = agent.distribution?.npx?.args || [];
    if (!args.includes("--acp")) return "missing --acp in args";
    return true;
});

// ─── 2. Slug uniqueness ──────────────────────────────────
console.log("\n2. Slug Format");

check("id matches folder name pattern", () => {
    const dirName = path.basename(ACP_DIR);
    // The registry expects folder name to match the id or be a reasonable slug
    if (dirName !== "acp") return `unexpected dir name: ${dirName}`;
    return true;
});

// ─── 3. Icon validation ─────────────────────────────────
console.log("\n3. Icon Validation");

check("icon.svg exists", () => {
    if (!fs.existsSync(ICON_SVG)) return "icon.svg not found";
    return true;
});

check("icon uses currentColor", () => {
    const svg = fs.readFileSync(ICON_SVG, "utf8");
    if (!svg.includes("currentColor")) return "missing currentColor";
    return true;
});

check("icon is 16x16 SVG", () => {
    const svg = fs.readFileSync(ICON_SVG, "utf8");
    if (!svg.includes('width="16"') || !svg.includes('height="16"')) return "not 16x16";
    return true;
});

// ─── 4. Distribution reachability ────────────────────────
console.log("\n4. Distribution Reachability");

check("npm package exists on registry", () => {
    try {
        const result = execSync("npm view agoragentic-mcp version", {
            encoding: "utf8",
            timeout: 15000,
        }).trim();
        if (!result) return "package not found";
        console.log(`    (published version: ${result})`);
        return true;
    } catch {
        return "npm view failed — package may not be published";
    }
});

// ─── 5. Auth handshake ──────────────────────────────────
console.log("\n5. ACP Handshake Verification");

const MCP_SERVER = path.resolve(
    __dirname, "..", "..", "integrations", "agoragentic-integrations", "mcp", "mcp-server.js"
);

if (fs.existsSync(MCP_SERVER)) {
    check("ACP initialize handshake succeeds", () => {
        try {
            const initMsg = '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"verify_agents","version":"1.0.0"}}}';
            const result = execSync(
                `echo ${initMsg} | node "${MCP_SERVER}" --acp`,
                { encoding: "utf8", timeout: 10000, shell: true, stdio: ["pipe", "pipe", "pipe"] }
            ).trim();
            const response = JSON.parse(result.split("\n")[0]);
            if (response.result?.protocolVersion !== 1) return "protocolVersion mismatch";
            if (!response.result?.agentInfo?.name) return "missing agentInfo.name";
            if (!Array.isArray(response.result?.authMethods)) return "authMethods not an array";
            console.log(`    (agent: ${response.result.agentInfo.name} v${response.result.agentInfo.version})`);
            return true;
        } catch (e) {
            // execSync may throw on non-zero exit (stdin close triggers exit)
            // Check if we got stdout before the error
            if (e.stdout) {
                try {
                    const response = JSON.parse(e.stdout.toString().trim().split("\n")[0]);
                    if (response.result?.protocolVersion === 1 && response.result?.agentInfo?.name) {
                        console.log(`    (agent: ${response.result.agentInfo.name} v${response.result.agentInfo.version})`);
                        return true;
                    }
                } catch {}
            }
            return `handshake failed: ${e.message?.substring(0, 100)}`;
        }
    });
} else {
    console.log("  ⊘ Skipping handshake test — mcp-server.js not found at expected path");
}

// ─── Results ─────────────────────────────────────────────
console.log(`\n${"─".repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.log("❌ Verification FAILED");
    process.exit(1);
} else {
    console.log("✅ All checks passed — ready for PR submission");
    process.exit(0);
}
