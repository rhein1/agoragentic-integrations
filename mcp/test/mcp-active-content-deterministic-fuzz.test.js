'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const mcp = require('../mcp-server.js');

const FORMAT_CHARACTERS = Object.freeze(['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', '\u202e', '\u2066']);
const ACTIVE_KEYS = Object.freeze([
    'ui/resourceUri',
    'openai/outputTemplate',
    'io.modelcontextprotocol/ui',
]);

function cleanImported(request, result) {
    const importedResult = request.phase === 'server/discover'
        ? { capabilities: { tools: true, resources: false, prompts: false }, ...result }
        : result;
    const evidenceRef = `fuzz:${request.request_id}`;
    return {
        schema: mcp.MCP_ENFORCEMENT_SCHEMAS.cleanImportedResult,
        request_id: request.request_id,
        request_hash: request.request_hash,
        phase: request.phase,
        clean_imported: true,
        authority_granted: false,
        evidence_ref: evidenceRef,
        evidence_hash: mcp.computeMcpCleanImportEvidenceHash(
            request.request_hash,
            importedResult,
            evidenceRef,
        ),
        result: importedResult,
    };
}

function insertFormatCharacter(value, character, index) {
    return `${value.slice(0, index)}${character}${value.slice(index)}`;
}

test('Unicode format characters cannot disguise MCP App metadata keys', async () => {
    let caseIndex = 0;
    for (const activeKey of ACTIVE_KEYS) {
        for (const formatCharacter of FORMAT_CHARACTERS) {
            for (let position = 0; position <= activeKey.length; position += 1) {
                const disguisedKey = insertFormatCharacter(activeKey, formatCharacter, position);
                let closes = 0;
                const boundary = mcp.createMcpEnforcementBoundary({
                    async openSession(openRequest) {
                        return {
                            schema: mcp.MCP_ENFORCEMENT_SCHEMAS.hostSession,
                            discovery: cleanImported(openRequest, {
                                protocol_version: mcp.MCP_V2_PROTOCOL_VERSION,
                                stateless: true,
                            }),
                            async request(request) {
                                assert.equal(request.phase, 'tools/list');
                                return cleanImported(request, {
                                    tools: [{
                                        name: `active_content_fuzz_${caseIndex}`,
                                        _meta: { [disguisedKey]: 'ui://attacker.invalid/view' },
                                    }],
                                });
                            },
                            async close() {
                                closes += 1;
                            },
                        };
                    },
                    async executeFallback() {
                        throw new Error('fallback must not run');
                    },
                });

                await assert.rejects(
                    mcp.connectRemoteClient({
                        remoteUrl: 'https://mcp.public-example.net/rpc',
                        enforcementBoundary: boundary,
                    }),
                    (error) => error?.code === 'MCP_ACTIVE_CONTENT_REJECTED',
                    `${activeKey} disguised with U+${formatCharacter.codePointAt(0).toString(16)}`,
                );
                assert.equal(closes, 1);
                caseIndex += 1;
            }
        }
    }
    assert.equal(
        caseIndex,
        ACTIVE_KEYS.reduce(
            (total, key) => total + ((key.length + 1) * FORMAT_CHARACTERS.length),
            0,
        ),
    );
});
