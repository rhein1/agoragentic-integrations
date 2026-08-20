#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { types: { isProxy } } = require('node:util');
const { version: PACKAGE_VERSION } = require('./package.json');

const DEFAULT_REMOTE_MCP_URL = 'https://agoragentic.com/api/mcp';
const REMOTE_MCP_URL = process.env.AGORAGENTIC_MCP_URL || DEFAULT_REMOTE_MCP_URL;
const EXPLICIT_AGORAGENTIC_BASE = process.env.AGORAGENTIC_BASE_URL || '';

function fallbackBaseForRemote(remoteMcpUrl) {
    if (EXPLICIT_AGORAGENTIC_BASE) return EXPLICIT_AGORAGENTIC_BASE;
    try {
        return new URL(remoteMcpUrl).origin;
    } catch {
        return '';
    }
}

const AGORAGENTIC_BASE = fallbackBaseForRemote(REMOTE_MCP_URL);
const MCP_V2_PROTOCOL_VERSION = '2026-07-28';
const ACP_MODE = process.argv.includes('--acp');

const MCP_ENFORCEMENT_SCHEMAS = Object.freeze({
    boundary: 'agoragentic.mcp.host-enforcement-capability.v1',
    sessionOpenRequest: 'agoragentic.mcp.enforced-session-open-request.v1',
    phaseRequest: 'agoragentic.mcp.enforced-phase-request.v1',
    fallbackRequest: 'agoragentic.mcp.enforced-fallback-request.v1',
    hostSession: 'agoragentic.mcp.enforced-host-session.v1',
    cleanImportedResult: 'agoragentic.mcp.clean-imported-result.v1',
    session: 'agoragentic.mcp.enforced-session.v1',
});
const MCP_PHASES = new Set([
    'server/discover',
    'tools/list',
    'tools/call',
    'resources/list',
    'resources/read',
    'prompts/list',
    'prompts/get',
    'UNKNOWN',
]);
const MAX_ENFORCEMENT_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ENFORCEMENT_JSON_DEPTH = 50;
const MAX_ENFORCEMENT_JSON_NODES = 50_000;
const MAX_REMOTE_TOOL_DIRECTORY_PAGES = 100;
const MAX_REMOTE_TOOL_DIRECTORY_TOOLS = 50_000;
const MAX_REMOTE_TOOL_DIRECTORY_BYTES = MAX_ENFORCEMENT_JSON_BYTES;
const MAX_REMOTE_TOOL_CURSOR_LENGTH = 4096;
const MAX_ACP_SESSIONS = 1000;
const MAX_ACP_CWD_LENGTH = 4096;
const MIN_CREDENTIAL_ASSIGNMENT_VALUE_LENGTH = 8;
const enforcementBoundaryAdapters = new WeakMap();
const enforcedSessionRecords = new WeakMap();
const IRREVERSIBLE_TOOLS = new Set([
    'agoragentic_register',
    'agoragentic_execute',
    'agoragentic_invoke',
    'agoragentic_call_service',
    'agoragentic_quote',
    'agoragentic_quote_service',
    'agoragentic_preview_x402',
]);
const SENSITIVE_CREDENTIAL_KEY_SEQUENCES = Object.freeze([
    ['api', 'key'],
    ['access', 'token'],
    ['refresh', 'token'],
    ['auth', 'token'],
    ['auth'],
    ['token'],
    ['authorization'],
    ['bearer'],
    ['credential'],
    ['cookie'],
    ['set', 'cookie'],
    ['password'],
    ['passwd'],
    ['secret'],
    ['private', 'key'],
    ['signing', 'key'],
    ['wallet'],
    ['payment', 'signature'],
]);
const SENSITIVE_CREDENTIAL_JOINED_KEYS = Object.freeze([
    'apikey',
    'accesskey',
    'accesstoken',
    'refreshtoken',
    'authtoken',
    'clientsecret',
    'privatekey',
    'signingkey',
    'setcookie',
    'paymentsignature',
]);
const CREDENTIAL_VALUE_PATTERNS = Object.freeze([
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
    /\bamk_[A-Za-z0-9_-]{12,}\b/,
    /-----BEGIN (?:RSA |EC |OPENSSH |PGP |ENCRYPTED )?[A-Z ]*PRIVATE KEY-----/i,
]);

class McpEnforcementError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'McpEnforcementError';
        this.code = code;
    }
}

function assertPlainRecord(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${field} must be a plain object`);
    }
    if (isProxy(value)) throw new TypeError(`${field} must not be a Proxy`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${field} must be a plain object`);
    }
    return value;
}

function assertExactKeys(value, keys, field) {
    assertPlainRecord(value, field);
    const allowed = new Set(keys);
    if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError(`${field} contains a symbol key`);
    }
    for (const key of Object.getOwnPropertyNames(value)) {
        if (!allowed.has(key)) throw new TypeError(`${field}.${key} is not allowed`);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
            throw new TypeError(`${field}.${key} is hidden or accessor-backed`);
        }
    }
}

function cloneBoundedJson(value, field = 'value') {
    let nodes = 0;
    let bytes = 0;
    const ancestors = new WeakSet();

    function walk(current, path, depth) {
        nodes += 1;
        if (nodes > MAX_ENFORCEMENT_JSON_NODES) {
            throw new TypeError(`${field} exceeds the JSON node limit`);
        }
        if (depth > MAX_ENFORCEMENT_JSON_DEPTH) {
            throw new TypeError(`${field} exceeds the JSON depth limit`);
        }
        if (current === null || typeof current === 'boolean') return current;
        if (typeof current === 'string') {
            bytes += Buffer.byteLength(current, 'utf8');
            if (bytes > MAX_ENFORCEMENT_JSON_BYTES) {
                throw new TypeError(`${field} exceeds the JSON byte limit`);
            }
            return current;
        }
        if (typeof current === 'number') {
            if (!Number.isFinite(current) || Object.is(current, -0)) {
                throw new TypeError(`${path} must be a finite, unambiguous JSON number`);
            }
            if (Number.isInteger(current) && !Number.isSafeInteger(current)) {
                throw new TypeError(`${path} is outside the safe integer range`);
            }
            return current;
        }
        if (!current || typeof current !== 'object') {
            throw new TypeError(`${path} is not a JSON value`);
        }
        if (isProxy(current)) throw new TypeError(`${path} must not be a Proxy`);
        if (ancestors.has(current)) throw new TypeError(`${path} contains a cycle`);
        ancestors.add(current);
        try {
            const descriptors = Object.getOwnPropertyDescriptors(current);
            if (Object.getOwnPropertySymbols(current).length > 0) {
                throw new TypeError(`${path} contains a symbol key`);
            }
            for (const [key, descriptor] of Object.entries(descriptors)) {
                if (Array.isArray(current) && key === 'length') continue;
                if (!descriptor.enumerable || descriptor.get || descriptor.set) {
                    throw new TypeError(`${path}.${key} is hidden or accessor-backed`);
                }
            }
            if (Array.isArray(current)) {
                if (Object.getPrototypeOf(current) !== Array.prototype) {
                    throw new TypeError(`${path} must use the standard Array prototype`);
                }
                const keys = Object.keys(current);
                if (keys.length !== current.length
                    || keys.some((key) => !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length)) {
                    throw new TypeError(`${path} is sparse or has extra properties`);
                }
                const output = [];
                for (let index = 0; index < current.length; index += 1) {
                    if (!Object.prototype.hasOwnProperty.call(current, index)) {
                        throw new TypeError(`${path} is sparse`);
                    }
                    output.push(walk(current[index], `${path}[${index}]`, depth + 1));
                }
                return output;
            }
            assertPlainRecord(current, path);
            const output = {};
            for (const key of Object.keys(current).sort()) {
                if (['__proto__', 'constructor', 'prototype'].includes(key)) {
                    throw new TypeError(`${path}.${key} is forbidden`);
                }
                output[key] = walk(current[key], `${path}.${key}`, depth + 1);
            }
            return output;
        } finally {
            ancestors.delete(current);
        }
    }

    const cloned = walk(value, '$', 0);
    const serialized = JSON.stringify(cloned);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_ENFORCEMENT_JSON_BYTES) {
        throw new TypeError(`${field} exceeds the serialized JSON byte limit`);
    }
    return cloned;
}

function stableJson(value) {
    return JSON.stringify(cloneBoundedJson(value, 'hash input'));
}

function deepFreezeJson(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreezeJson(child);
        Object.freeze(value);
    }
    return value;
}

function normalizeCredentialKeyTokens(key) {
    return String(key)
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .map((token) => (token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token));
}

function credentialKeyClassification(key) {
    const tokens = normalizeCredentialKeyTokens(key);
    const suffix = tokens.at(-1);
    let referenceKind = suffix === 'ref' || suffix === 'hash' ? suffix : null;
    const baseTokens = referenceKind ? tokens.slice(0, -1) : tokens;
    let joinedBase = baseTokens.join('');
    if (!referenceKind) {
        for (const kind of ['ref', 'hash']) {
            if (!joinedBase.endsWith(kind)) continue;
            const candidate = joinedBase.slice(0, -kind.length);
            const candidateSensitive = SENSITIVE_CREDENTIAL_JOINED_KEYS.some(
                (joinedKey) => candidate.includes(joinedKey),
            ) || SENSITIVE_CREDENTIAL_KEY_SEQUENCES.some(
                (sequence) => candidate === sequence.join(''),
            );
            if (candidateSensitive) {
                referenceKind = kind;
                joinedBase = candidate;
                break;
            }
        }
    }
    const sensitive = SENSITIVE_CREDENTIAL_JOINED_KEYS.some(
        (joinedKey) => joinedBase.includes(joinedKey),
    ) || SENSITIVE_CREDENTIAL_KEY_SEQUENCES.some((sequence) => {
        if (sequence.length > baseTokens.length) return false;
        for (let start = 0; start <= baseTokens.length - sequence.length; start += 1) {
            if (sequence.every((token, index) => baseTokens[start + index] === token)) return true;
        }
        return false;
    });
    return { sensitive, referenceKind };
}

function assertOpaqueCredentialReference(value, path, kind) {
    if (value === null) return;
    if (typeof value !== 'string' || value.length < 1 || value.length > 500) {
        throw new McpEnforcementError(
            'MCP_CREDENTIAL_MATERIAL_REJECTED',
            `${path} must be an opaque ${kind} string or null`,
        );
    }
    if (kind === 'hash' && !/^sha256:[a-f0-9]{64}$/.test(value)) {
        throw new McpEnforcementError(
            'MCP_CREDENTIAL_MATERIAL_REJECTED',
            `${path} must be a sha256 reference`,
        );
    }
    if (kind === 'ref' && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,499}$/.test(value)) {
        throw new McpEnforcementError(
            'MCP_CREDENTIAL_MATERIAL_REJECTED',
            `${path} must be an opaque credential reference`,
        );
    }
    if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
        throw new McpEnforcementError(
            'MCP_CREDENTIAL_MATERIAL_REJECTED',
            `${path} contains credential-shaped material`,
        );
    }
}

function assertNoDuplicateJsonObjectKeys(text, field) {
    if (Buffer.byteLength(text, 'utf8') > MAX_ENFORCEMENT_JSON_BYTES) {
        throw new TypeError(`${field} exceeds the JSON byte limit`);
    }
    let index = 0;
    let nodes = 0;

    function syntaxError() {
        throw new SyntaxError(`${field} is not valid JSON`);
    }

    function skipWhitespace() {
        while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1;
    }

    function readString() {
        if (text[index] !== '"') syntaxError();
        index += 1;
        let decoded = '';
        while (index < text.length) {
            const character = text[index];
            index += 1;
            if (character === '"') return decoded;
            if (character === '\\') {
                if (index >= text.length) syntaxError();
                const escape = text[index];
                index += 1;
                const simpleEscapes = {
                    '"': '"',
                    '\\': '\\',
                    '/': '/',
                    b: '\b',
                    f: '\f',
                    n: '\n',
                    r: '\r',
                    t: '\t',
                };
                if (Object.hasOwn(simpleEscapes, escape)) {
                    decoded += simpleEscapes[escape];
                    continue;
                }
                if (escape !== 'u' || !/^[a-fA-F0-9]{4}$/.test(text.slice(index, index + 4))) {
                    syntaxError();
                }
                decoded += String.fromCharCode(Number.parseInt(text.slice(index, index + 4), 16));
                index += 4;
                continue;
            }
            if (character.charCodeAt(0) <= 0x1f) syntaxError();
            decoded += character;
        }
        syntaxError();
    }

    function parseValue(depth) {
        nodes += 1;
        if (nodes > MAX_ENFORCEMENT_JSON_NODES) {
            throw new TypeError(`${field} exceeds the JSON node limit`);
        }
        if (depth > MAX_ENFORCEMENT_JSON_DEPTH) {
            throw new TypeError(`${field} exceeds the JSON depth limit`);
        }
        skipWhitespace();
        const character = text[index];
        if (character === '{') {
            parseObject(depth);
            return;
        }
        if (character === '[') {
            parseArray(depth);
            return;
        }
        if (character === '"') {
            readString();
            return;
        }
        for (const literal of ['true', 'false', 'null']) {
            if (text.startsWith(literal, index)) {
                index += literal.length;
                return;
            }
        }
        const number = text.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
        if (!number) syntaxError();
        index += number[0].length;
    }

    function parseObject(depth) {
        index += 1;
        const keys = new Set();
        skipWhitespace();
        if (text[index] === '}') {
            index += 1;
            return;
        }
        while (index < text.length) {
            skipWhitespace();
            const key = readString();
            const normalizedKey = key.normalize('NFC');
            if (keys.has(normalizedKey)) {
                throw new McpEnforcementError(
                    'MCP_CREDENTIAL_MATERIAL_REJECTED',
                    `${field} contains duplicate JSON object key ${JSON.stringify(key)}`,
                );
            }
            keys.add(normalizedKey);
            skipWhitespace();
            if (text[index] !== ':') syntaxError();
            index += 1;
            parseValue(depth + 1);
            skipWhitespace();
            if (text[index] === '}') {
                index += 1;
                return;
            }
            if (text[index] !== ',') syntaxError();
            index += 1;
        }
        syntaxError();
    }

    function parseArray(depth) {
        index += 1;
        skipWhitespace();
        if (text[index] === ']') {
            index += 1;
            return;
        }
        while (index < text.length) {
            parseValue(depth + 1);
            skipWhitespace();
            if (text[index] === ']') {
                index += 1;
                return;
            }
            if (text[index] !== ',') syntaxError();
            index += 1;
        }
        syntaxError();
    }

    parseValue(0);
    skipWhitespace();
    if (index !== text.length) syntaxError();
}

async function* readBoundedLines(input, maxBytes, field) {
    const lineBuffer = Buffer.allocUnsafe(maxBytes);
    let lineLength = 0;
    let discardingOversizedLine = false;

    for await (const inputChunk of input) {
        const chunk = Buffer.isBuffer(inputChunk)
            ? inputChunk
            : Buffer.from(String(inputChunk), 'utf8');
        let offset = 0;
        while (offset < chunk.length) {
            const newline = chunk.indexOf(0x0a, offset);
            const segmentEnd = newline === -1 ? chunk.length : newline;
            const segmentLength = segmentEnd - offset;
            if (!discardingOversizedLine) {
                if (lineLength + segmentLength > maxBytes) {
                    discardingOversizedLine = true;
                    lineLength = 0;
                } else if (segmentLength > 0) {
                    chunk.copy(lineBuffer, lineLength, offset, segmentEnd);
                    lineLength += segmentLength;
                }
            }
            if (newline === -1) break;

            if (discardingOversizedLine) {
                yield { error: new TypeError(`${field} exceeds the JSON byte limit`) };
            } else {
                const contentLength = lineLength > 0 && lineBuffer[lineLength - 1] === 0x0d
                    ? lineLength - 1
                    : lineLength;
                yield { text: lineBuffer.toString('utf8', 0, contentLength) };
            }
            lineLength = 0;
            discardingOversizedLine = false;
            offset = newline + 1;
        }
    }

    if (discardingOversizedLine) {
        yield { error: new TypeError(`${field} exceeds the JSON byte limit`) };
    } else if (lineLength > 0) {
        const contentLength = lineBuffer[lineLength - 1] === 0x0d ? lineLength - 1 : lineLength;
        yield { text: lineBuffer.toString('utf8', 0, contentLength) };
    }
}

function parseBoundedPlainJson(text, field) {
    assertNoDuplicateJsonObjectKeys(text, field);
    const parsed = deepFreezeJson(cloneBoundedJson(JSON.parse(text), field));
    assertPlainRecord(parsed, field);
    return parsed;
}

function assertNoCredentialMaterial(value, field, { phase = null } = {}) {
    const propertySchemaMapKeywords = new Set(['properties', 'patternProperties']);
    const namedSchemaMapKeywords = new Set(['$defs', 'definitions', 'dependentSchemas']);
    const singleSchemaKeywords = new Set([
        'additionalProperties',
        'unevaluatedProperties',
        'propertyNames',
        'contains',
        'not',
        'if',
        'then',
        'else',
        'contentSchema',
    ]);
    const schemaArrayKeywords = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

    function isToolSchemaRoot(pathTokens) {
        return phase === 'tools/list'
            && pathTokens.length === 4
            && pathTokens[0] === 'result'
            && pathTokens[1] === 'tools'
            && Number.isInteger(pathTokens[2])
            && ['inputSchema', 'outputSchema'].includes(pathTokens[3]);
    }

    function schemaRoleForChild(state, key, child, childTokens) {
        if (isToolSchemaRoot(childTokens)) return 'schema';
        if (state.schemaRole !== 'schema') return null;
        if (propertySchemaMapKeywords.has(key)
            && child
            && typeof child === 'object'
            && !Array.isArray(child)) {
            return 'property-schema-map';
        }
        if (namedSchemaMapKeywords.has(key)
            && child
            && typeof child === 'object'
            && !Array.isArray(child)) {
            return 'named-schema-map';
        }
        if (schemaArrayKeywords.has(key) && Array.isArray(child)) return 'schema-array';
        if (key === 'items') {
            return Array.isArray(child) ? 'schema-array' : 'schema';
        }
        if (singleSchemaKeywords.has(key)) return 'schema';
        return null;
    }

    function rejectSensitiveHeader(name, headerValue, path) {
        if (typeof name !== 'string' || headerValue === null || headerValue === undefined) return;
        if (credentialKeyClassification(name).sensitive) {
            throw new McpEnforcementError(
                'MCP_CREDENTIAL_MATERIAL_REJECTED',
                `${path} contains an authority-bearing credential header`,
            );
        }
    }

    function inspectStructuredHeader(current, path) {
        if (!current || typeof current !== 'object') return;
        if (Array.isArray(current) && current.length === 2) {
            rejectSensitiveHeader(current[0], current[1], `${path}[0]`);
            return;
        }
        if (Array.isArray(current)) return;
        for (const nameField of ['name', 'key']) {
            if (!Object.hasOwn(current, nameField)) continue;
            for (const valueField of ['value', 'values']) {
                if (!Object.hasOwn(current, valueField)) continue;
                rejectSensitiveHeader(
                    current[nameField],
                    current[valueField],
                    `${path}.${nameField}`,
                );
            }
        }
    }

    function parseJsonContentText(current, path, pathTokens) {
        if (pathTokens.length < 3
            || pathTokens.at(-1) !== 'text'
            || !Number.isInteger(pathTokens.at(-2))
            || pathTokens.at(-3) !== 'content') {
            return null;
        }
        const trimmed = current.trim();
        if (!((trimmed.startsWith('{') && trimmed.endsWith('}'))
            || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
            return null;
        }
        try {
            assertNoDuplicateJsonObjectKeys(trimmed, `${path} embedded JSON`);
            return cloneBoundedJson(JSON.parse(trimmed), `${path} embedded JSON`);
        } catch (error) {
            if (error instanceof SyntaxError) return null;
            throw error;
        }
    }

    function decodeAssignmentToken(token) {
        return token
            .replace(/\\u([a-fA-F0-9]{4})/g, (_match, hex) => (
                String.fromCharCode(Number.parseInt(hex, 16))
            ))
            .replace(/\\(["'\\])/g, '$1');
    }

    function assertNoCredentialAssignments(current, path) {
        // Every imported string is already covered by the 4 MiB JSON bound.
        // Token and whitespace caps keep each assignment candidate bounded too.
        const assignments = current.matchAll(
            /(?:^|[\s{(\[,;?&:])(?:"((?:\\.|[^"\\\r\n]){1,128})"|'((?:\\.|[^'\\\r\n]){1,128})'|([A-Za-z][A-Za-z0-9_.-]{0,127}))[ \t]{0,256}(?:=|:)[ \t]{0,256}(?:"((?:\\.|[^"\\\r\n]){0,2048})"|'((?:\\.|[^'\\\r\n]){0,2048})'|([^\s,;}\]\r\n]{1,2048}))/g,
        );
        for (const match of assignments) {
            const rawKey = match[1] ?? match[2] ?? match[3];
            const classification = credentialKeyClassification(decodeAssignmentToken(rawKey));
            if (!classification.sensitive) continue;

            const rawValue = match[4] ?? match[5] ?? match[6] ?? '';
            const assignmentValue = decodeAssignmentToken(rawValue)
                .replace(/^["']/, '')
                .replace(/["']$/, '')
                .trim();
            if (classification.referenceKind) {
                assertOpaqueCredentialReference(
                    assignmentValue || null,
                    `${path}<assignment:${rawKey}>`,
                    classification.referenceKind,
                );
                continue;
            }
            if (assignmentValue.length >= MIN_CREDENTIAL_ASSIGNMENT_VALUE_LENGTH) {
                throw new McpEnforcementError(
                    'MCP_CREDENTIAL_MATERIAL_REJECTED',
                    `${path} contains credential-shaped assignment material`,
                );
            }
        }
    }

    function walk(current, path, pathTokens = [], state = {}) {
        if (typeof current === 'string') {
            if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(current))) {
                throw new McpEnforcementError(
                    'MCP_CREDENTIAL_MATERIAL_REJECTED',
                    `${path} contains credential-shaped material`,
                );
            }
            assertNoCredentialAssignments(current, path);
            const parsedContent = parseJsonContentText(current, path, pathTokens);
            if (parsedContent !== null) {
                walk(parsedContent, `${path}<json>`, [...pathTokens, '<json>']);
            }
            return;
        }
        if (!current || typeof current !== 'object') return;
        inspectStructuredHeader(current, path);
        if (Array.isArray(current)) {
            const childState = {
                sensitiveSchemaDefinition: state.sensitiveSchemaDefinition,
                schemaRole: state.schemaRole === 'schema-array' ? 'schema' : null,
            };
            current.forEach((child, index) => walk(
                child,
                `${path}[${index}]`,
                [...pathTokens, index],
                childState,
            ));
            return;
        }
        for (const [key, child] of Object.entries(current)) {
            const childPath = `${path}.${key}`;
            const childTokens = [...pathTokens, key];
            if (state.sensitiveSchemaDefinition
                && ['default', 'const', 'example', 'examples', 'enum'].includes(key)
                && child !== null
                && !(Array.isArray(child) && child.length === 0)) {
                throw new McpEnforcementError(
                    'MCP_CREDENTIAL_MATERIAL_REJECTED',
                    `${childPath} embeds a value for a credential-shaped schema property`,
                );
            }

            const classification = credentialKeyClassification(key);
            if (['property-schema-map', 'named-schema-map'].includes(state.schemaRole)) {
                if (classification.sensitive) assertPlainRecord(child, childPath);
                walk(child, childPath, childTokens, {
                    sensitiveSchemaDefinition: state.sensitiveSchemaDefinition
                        || classification.sensitive,
                    schemaRole: 'schema',
                });
                continue;
            }
            if (classification.sensitive) {
                if (classification.referenceKind) {
                    assertOpaqueCredentialReference(child, childPath, classification.referenceKind);
                    continue;
                }
                if (child !== null) {
                    throw new McpEnforcementError(
                        'MCP_CREDENTIAL_MATERIAL_REJECTED',
                        `${childPath} contains authority-bearing credential material`,
                    );
                }
            }

            walk(child, childPath, childTokens, {
                sensitiveSchemaDefinition: state.sensitiveSchemaDefinition,
                schemaRole: schemaRoleForChild(state, key, child, childTokens),
            });
        }
    }
    walk(value, field);
}

function sha256Ref(value) {
    return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function assertCanonicalEvidenceRef(evidenceRef, field = 'evidenceRef') {
    if (typeof evidenceRef !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,499}$/.test(evidenceRef)) {
        throw new TypeError(`${field} must be a canonical evidence reference`);
    }
    return evidenceRef;
}

function computeMcpCleanImportEvidenceHash(requestHash, result, evidenceRef) {
    if (!/^sha256:[a-f0-9]{64}$/.test(requestHash)) {
        throw new TypeError('requestHash must be a sha256 reference');
    }
    const canonicalEvidenceRef = assertCanonicalEvidenceRef(evidenceRef);
    return sha256Ref({
        evidence_ref: canonicalEvidenceRef,
        request_hash: requestHash,
        result,
    });
}

function normalizeRemoteTarget(value, { allowQuery = false } = {}) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new TypeError('remoteUrl must be an absolute HTTP(S) URL');
    }
    if (!['http:', 'https:'].includes(url.protocol)
        || url.username
        || url.password
        || url.hash
        || (!allowQuery && url.search)) {
        throw new TypeError(
            'remoteUrl must be an absolute credential-free HTTP(S) URL without query, fragment, or userinfo',
        );
    }
    for (const [key, entry] of url.searchParams) {
        if (credentialKeyClassification(key).sensitive
            || CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(entry))) {
            throw new McpEnforcementError(
                'MCP_CREDENTIAL_MATERIAL_REJECTED',
                'remoteUrl must not contain credential material',
            );
        }
    }
    return Object.freeze({ href: url.href, origin: url.origin });
}

function enforcementRequired(message = 'A factory-created MCP enforcement host capability is required') {
    return new McpEnforcementError('MCP_RISK_FORK_ENFORCEMENT_REQUIRED', message);
}

function requireEnforcementBoundary(boundary) {
    const adapter = enforcementBoundaryAdapters.get(boundary);
    if (!adapter) throw enforcementRequired();
    return adapter;
}

function riskProfileFor(phase, toolName = null) {
    return Object.freeze({
        minimum_level: phase === 'tools/call' && IRREVERSIBLE_TOOLS.has(toolName)
            ? 'IRREVERSIBLE'
            : 'HIGH',
        untrusted_content: true,
        prepare_only: phase === 'tools/call' && IRREVERSIBLE_TOOLS.has(toolName),
    });
}

function transportConstraints() {
    return Object.freeze({
        direct_network_permitted: false,
        redirects: 'error',
        response_acceptance: 'clean_import_only',
        fallback_on_protocol_error: false,
        credential_material_in_child: false,
    });
}

function buildEnforcementRequest({
    schema,
    phase,
    remoteUrl,
    params = {},
    toolName = null,
    sessionBindingHash = null,
    extra = {},
}) {
    if (!MCP_PHASES.has(phase)) throw new TypeError(`Unsupported MCP enforcement phase: ${phase}`);
    const target = normalizeRemoteTarget(remoteUrl, {
        allowQuery: schema === MCP_ENFORCEMENT_SCHEMAS.fallbackRequest,
    });
    const safeParams = cloneBoundedJson(params, 'MCP enforcement params');
    assertPlainRecord(safeParams, 'MCP enforcement params');
    assertNoCredentialMaterial(safeParams, 'MCP enforcement params');
    const safeExtra = cloneBoundedJson(extra, 'MCP enforcement metadata');
    assertExactKeys(safeExtra, ['raw_method', 'fallback_http'], 'MCP enforcement metadata');
    assertNoCredentialMaterial(safeExtra, 'MCP enforcement metadata');
    const rawMethod = phase === 'UNKNOWN' ? String(safeExtra.raw_method || '') : null;
    const request = {
        schema,
        request_id: `mcp-enforcement:${crypto.randomUUID()}`,
        phase,
        raw_method: rawMethod,
        mcp_server_ref: target.href,
        mcp_server_origin: target.origin,
        session_binding_hash: sessionBindingHash,
        tool_name: toolName,
        params: safeParams,
        risk_profile: riskProfileFor(phase, toolName),
        transport_constraints: transportConstraints(),
        fallback_http: safeExtra.fallback_http ?? null,
        request_hash: null,
    };
    if (phase === 'UNKNOWN' && !request.raw_method) {
        throw new TypeError('UNKNOWN MCP enforcement requests require raw_method');
    }
    request.request_hash = sha256Ref({ ...request, request_hash: null });
    if (sessionBindingHash !== null && !/^sha256:[a-f0-9]{64}$/.test(sessionBindingHash)) {
        throw new TypeError('sessionBindingHash must be a sha256 reference');
    }
    return deepFreezeJson(request);
}

function verifyCleanImportedEnvelope(value, request) {
    const imported = deepFreezeJson(cloneBoundedJson(value, 'clean imported result'));
    assertNoCredentialMaterial(imported, 'clean imported result', { phase: request.phase });
    assertExactKeys(imported, [
        'schema',
        'request_id',
        'request_hash',
        'phase',
        'clean_imported',
        'authority_granted',
        'evidence_ref',
        'evidence_hash',
        'result',
    ], 'clean imported result');
    if (imported.schema !== MCP_ENFORCEMENT_SCHEMAS.cleanImportedResult
        || imported.request_id !== request.request_id
        || imported.request_hash !== request.request_hash
        || imported.phase !== request.phase
        || imported.clean_imported !== true
        || imported.authority_granted !== false) {
        throw new McpEnforcementError(
            'MCP_RISK_FORK_IMPORT_INVALID',
            'The host did not return an exact clean-imported result for this request',
        );
    }
    assertCanonicalEvidenceRef(imported.evidence_ref, 'clean imported result.evidence_ref');
    if (!/^sha256:[a-f0-9]{64}$/.test(imported.evidence_hash)) {
        throw new TypeError('clean imported result.evidence_hash is invalid');
    }
    const expectedEvidenceHash = computeMcpCleanImportEvidenceHash(
        request.request_hash,
        imported.result,
        imported.evidence_ref,
    );
    if (imported.evidence_hash !== expectedEvidenceHash) {
        throw new McpEnforcementError(
            'MCP_RISK_FORK_IMPORT_INVALID',
            'The clean-import evidence hash does not bind this request and result',
        );
    }
    return imported;
}

function verifyCleanImportedResult(value, request) {
    return verifyCleanImportedEnvelope(value, request).result;
}

function createMcpEnforcementBoundary(hostAdapter = {}) {
    assertExactKeys(hostAdapter, ['openSession', 'executeFallback'], 'MCP enforcement host adapter');
    if (typeof hostAdapter.openSession !== 'function' || typeof hostAdapter.executeFallback !== 'function') {
        throw new TypeError('MCP enforcement host adapter requires openSession and executeFallback functions');
    }
    const boundary = Object.freeze({
        schema: MCP_ENFORCEMENT_SCHEMAS.boundary,
        mode: 'host_owns_network_and_clean_import',
    });
    enforcementBoundaryAdapters.set(boundary, Object.freeze({
        openSession: hostAdapter.openSession,
        executeFallback: hostAdapter.executeFallback,
    }));
    return boundary;
}

const ACP_ENFORCEMENT_NOTE = ' Network execution is fail-closed unless an embedding host supplies a separately qualified enforcement implementation.';
const ACP_TOOLS = [
    {
        name: 'agoragentic_execute',
        description: `Route a task through Agent OS execute() with provider selection, fallback, receipts, and settlement.${ACP_ENFORCEMENT_NOTE}`,
    },
    {
        name: 'agoragentic_match',
        description: `Preview routed providers before execution.${ACP_ENFORCEMENT_NOTE}`,
    },
    {
        name: 'agoragentic_quote',
        description: `Create a bounded quote before paid execution.${ACP_ENFORCEMENT_NOTE}`,
    },
    {
        name: 'agoragentic_status',
        description: `Inspect execution status for an invocation.${ACP_ENFORCEMENT_NOTE}`,
    },
    {
        name: 'agoragentic_receipt',
        description: `Fetch normalized receipt and settlement metadata.${ACP_ENFORCEMENT_NOTE}`,
    },
    {
        name: 'agoragentic_browse_services',
        description: `Browse stable x402 edge resources.${ACP_ENFORCEMENT_NOTE}`,
    },
    {
        name: 'agoragentic_call_service',
        description: `Call a stable x402 edge resource after payment challenge handling.${ACP_ENFORCEMENT_NOTE}`,
    },
    {
        name: 'agoragentic_edge_receipt',
        description: `Inspect x402 edge receipt metadata.${ACP_ENFORCEMENT_NOTE}`,
    },
    {
        name: 'agoragentic_x402_test',
        description: `Exercise the free x402 pipeline canary.${ACP_ENFORCEMENT_NOTE}`,
    },
];
const ACP_TOOL_NAMES = new Set(ACP_TOOLS.map((tool) => tool.name));

function buildJsonContent(data) {
    return {
        content: [
            {
                type: 'text',
                text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
            },
        ],
    };
}

function buildFallbackToolList() {
    return [
        {
            name: 'agoragentic_register',
            description:
                'Register a new agent with the Agoragentic marketplace through an enforcement host. ' +
                'Use this as the first step before calling agoragentic_execute, agoragentic_match, or agoragentic_execute_status. ' +
                'Registration is expected to be idempotent for the same agent name, but the enforcement host must consume any returned credential before clean import. ' +
                'The package rejects raw credentials in clean-imported results; a qualified host must store any returned secret out of band and expose only a non-authority reference. ' +
                'Side effects: creates a persistent agent record on the Agoragentic server if one does not exist. ' +
                'Returns clean-imported agent metadata only after host enforcement. ' +
                'On error, returns JSON with ok:false and an error message string.',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Human-readable agent name, e.g. "my-research-agent"' },
                    agent_name: { type: 'string', description: 'Alias for the name field (backward compatibility). Prefer using name instead.' },
                    intent: {
                        type: 'string',
                        enum: ['buyer', 'seller', 'both'],
                        description: 'Agent marketplace role: "buyer" to consume services, "seller" to provide them, or "both"',
                        default: 'buyer',
                    },
                    description: { type: 'string', description: 'One-line summary of what this agent does, e.g. "Summarizes web pages on demand"' },
                },
            },
        },
        {
            name: 'agoragentic_search',
            description:
                'Search the public Agoragentic marketplace for available agent capabilities and services. ' +
                'Use this to discover what services exist before calling agoragentic_execute or agoragentic_match. ' +
                'This is a read-only operation with no side effects and no USDC spend. ' +
                'Any network call still requires the embedding enforcement host. ' +
                'Returns JSON with an array of matching capabilities, each containing id, name, description, category, and price_usdc. ' +
                'Returns an empty array when no capabilities match the query.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Free-text search query, e.g. "text summarization" or "web scraping"' },
                    category: { type: 'string', description: 'Filter results by category slug, e.g. "ai-ml", "data", or "web". Omit to search all categories.' },
                    limit: { type: 'number', description: 'Maximum number of results to return (1\u2013100)', default: 10 },
                },
            },
        },
        {
            name: 'agoragentic_preview_x402',
            description:
                'Preview route-first x402-eligible providers for a task WITHOUT registration, provider execution, or USDC spend. ' +
                'The network preview remains fail-closed unless an embedding host supplies a separately qualified enforcement implementation. ' +
                'Calls the public GET /api/x402/execute/match endpoint and may return an expiring quote_id for a later x402 paid retry. ' +
                'Use this before agoragentic_register or authenticated agoragentic_match when the buyer has an external Base USDC wallet or wants a zero-auth preview. ' +
                'This is NOT read-only in the catalog sense: it can mint an expiring quote_id. It is still safe because it does not register an agent, execute a provider, move wallet funds, or settle payment. ' +
                'Returns JSON with matched providers, selected_provider, quote (including any quote_id), payment rails, and next-step execution metadata.',
            inputSchema: {
                type: 'object',
                properties: {
                    task: { type: 'string', description: 'Natural-language task to preview, e.g. "receipt reconciliation" or "audit agent discovery for a domain"' },
                    max_cost: { type: 'number', description: 'Maximum acceptable USDC price per call. Defaults server-side when omitted.' },
                    category: { type: 'string', description: 'Optional marketplace category filter.' },
                    max_latency_ms: { type: 'number', description: 'Optional maximum acceptable provider latency in milliseconds.' },
                    prefer_trusted: { type: 'boolean', description: 'When true, ask the router to prefer trusted providers when ranking.', default: false },
                    payment_network: { type: 'string', description: 'Optional requested payment network, e.g. "base" or "eip155:8453".' },
                    payment_asset: { type: 'string', description: 'Optional requested payment asset. Defaults to USDC server-side.' },
                },
                required: ['task'],
            },
        },
        {
            name: 'agoragentic_match',
            description:
                'Preview which providers the Agoragentic Router would select for a given task, without executing or spending USDC. ' +
                'Use this before agoragentic_execute to compare providers, check pricing, and verify availability. ' +
                'This is a read-only, non-destructive operation with no side effects. ' +
                'Any required credential must be resolved out of band by the embedding enforcement host; it is never included in the request descriptor or imported result. ' +
                'Returns JSON with matched providers including their trust scores, estimated cost in USDC, and routing rationale.',
            inputSchema: {
                type: 'object',
                properties: {
                    task: { type: 'string', description: 'Natural-language task description to match against providers, e.g. "summarize this article"' },
                    max_cost: { type: 'number', description: 'Maximum acceptable USDC price per call. Providers above this price are excluded from results.' },
                    category: { type: 'string', description: 'Optional category filter to narrow provider matches, e.g. "ai-ml"' },
                    prefer_trusted: { type: 'boolean', description: 'When true, rank verified and trusted providers higher in results', default: true },
                },
                required: ['task'],
            },
        },
        {
            name: 'agoragentic_execute',
            description:
                'Execute a task through the Agoragentic Router / Marketplace. The Router selects a provider, invokes it, and returns the result with a receipt. ' +
                'IMPORTANT: This tool MAY SPEND USDC from the authenticated agent wallet based on the matched provider listing price. ' +
                'This tool is NOT idempotent \u2014 each call creates a new invocation and may incur a charge. ' +
                'Prefer agoragentic_match first to preview providers and pricing without spending. ' +
                'Use agoragentic_search to discover available capabilities before executing. ' +
                'Do NOT call this tool for read-only discovery; use agoragentic_search or agoragentic_match instead. ' +
                'Any required credential must be resolved out of band by the embedding enforcement host; it is never included in the request descriptor or imported result. ' +
                'On success, returns JSON with: invocation_id (string), output (provider result object), cost_usdc (number), provider_id (string), and receipt metadata. ' +
                'On failure, returns JSON with ok:false, a status code, and error details describing routing or provider errors.',
            inputSchema: {
                type: 'object',
                properties: {
                    task: {
                        type: 'string',
                        description: 'Natural-language task for the Router to match and execute, e.g. "summarize this article" or "scrape https://example.com"',
                    },
                    input: {
                        type: 'object',
                        description:
                            'Structured input payload forwarded to the matched provider. Shape depends on the provider API. ' +
                            'Example: {"text": "Hello world", "max_sentences": 3}',
                        default: {},
                    },
                    constraints: {
                        type: 'object',
                        description:
                            'Optional routing and budget constraints. Supported fields: max_cost (number, maximum USDC per call), ' +
                            'provider_id (string, pin to a specific provider), category (string). ' +
                            'Example: {"max_cost": 0.05, "category": "ai-ml"}',
                        default: {},
                    },
                    quote_id: {
                        type: 'string',
                        description: 'ID from a prior agoragentic_quote call to lock in a pre-agreed price. Omit for standard dynamic pricing.',
                    },
                    intent_contract_id: {
                        type: 'string',
                        description: 'Agent OS intent contract ID for auditable intent-to-execution tracking. Omit if not using intent contracts.',
                    },
                },
                required: ['task'],
            },
        },
        {
            name: 'agoragentic_execute_status',
            description:
                'Check the status, output, cost, and receipt of a previous agoragentic_execute invocation. ' +
                'Use this to poll for results of async executions or to retrieve receipt metadata after completion. ' +
                'This is a read-only operation with no side effects and no USDC spend. ' +
                'Any required credential must be resolved out of band by the embedding enforcement host; it is never included in the request descriptor or imported result. ' +
                'Returns JSON with: status ("pending", "completed", or "failed"), output (provider result), cost_usdc, provider_id, receipt_id, and timestamps. ' +
                'Returns ok:false with error "invalid_invocation_id" if the ID is empty or contains disallowed characters.',
            inputSchema: {
                type: 'object',
                properties: {
                    invocation_id: {
                        type: 'string',
                        description: 'The invocation_id string returned by a prior agoragentic_execute call, e.g. "inv_abc123def456"',
                    },
                },
                required: ['invocation_id'],
            },
        },
    ];
}

function mergeFallbackTools(remoteTools = []) {
    const seen = new Set(remoteTools.map((tool) => tool.name));
    const merged = [...remoteTools];
    for (const tool of buildFallbackToolList()) {
        if (!seen.has(tool.name)) {
            merged.push(tool);
        }
    }
    return merged;
}

function validateRemoteToolListPage(result, field = 'clean tools/list result') {
    assertPlainRecord(result, field);
    if (!Array.isArray(result.tools)) {
        throw new TypeError(`${field}.tools must be an array`);
    }
    const names = result.tools.map((tool, index) => {
        assertPlainRecord(tool, `${field}.tools[${index}]`);
        if (typeof tool.name !== 'string' || !tool.name) {
            throw new TypeError(`${field}.tools[${index}].name is invalid`);
        }
        return tool.name;
    });
    let nextCursor = null;
    if (result.nextCursor !== undefined && result.nextCursor !== null) {
        if (typeof result.nextCursor !== 'string'
            || result.nextCursor.length < 1
            || result.nextCursor.length > MAX_REMOTE_TOOL_CURSOR_LENGTH) {
            throw new TypeError(`${field}.nextCursor is invalid`);
        }
        nextCursor = result.nextCursor;
    }
    return { names, nextCursor, tools: result.tools };
}

function createRemoteToolDirectory(session) {
    const sessionRecord = enforcedSessionRecords.get(session);
    if (!sessionRecord) {
        throw new TypeError('createRemoteToolDirectory requires an opaque enforced MCP session');
    }
    if (!sessionRecord.remoteToolFirstPage) {
        throw new McpEnforcementError(
            'MCP_REMOTE_TOOL_DIRECTORY_INCOMPLETE',
            'The enforced MCP session has no validated initial tool page',
        );
    }
    async function failIncomplete(message) {
        try {
            await session.close();
        } catch {
            // Preserve the deterministic directory failure.
        }
        throw new McpEnforcementError('MCP_REMOTE_TOOL_DIRECTORY_INCOMPLETE', message);
    }

    function createDirectoryEpoch(firstResult) {
        const firstPage = validateRemoteToolListPage(firstResult);
        let hydrationPromise = null;

        function hydrate() {
            if (hydrationPromise) return hydrationPromise;
            hydrationPromise = (async () => {
                const remoteTools = [...firstPage.tools];
                const remoteToolNames = new Set(firstPage.names);
                let remoteToolBytes = Buffer.byteLength(JSON.stringify(firstPage.tools), 'utf8');
                let nextCursor = firstPage.nextCursor;
                if (remoteToolBytes > MAX_REMOTE_TOOL_DIRECTORY_BYTES) {
                    await failIncomplete('Remote tools/list pagination exceeded the cumulative byte limit');
                }
                if (remoteTools.length > MAX_REMOTE_TOOL_DIRECTORY_TOOLS) {
                    await failIncomplete('Remote tools/list pagination exceeded the tool limit');
                }
                const seenCursors = new Set();
                let fetchedPages = 0;
                while (nextCursor !== null) {
                    if (seenCursors.has(nextCursor)) {
                        await failIncomplete('Remote tools/list pagination repeated a cursor');
                    }
                    if (fetchedPages >= MAX_REMOTE_TOOL_DIRECTORY_PAGES) {
                        await failIncomplete('Remote tools/list pagination exceeded the page limit');
                    }
                    const cursor = nextCursor;
                    seenCursors.add(cursor);
                    const result = await session.listTools({ cursor });
                    const page = validateRemoteToolListPage(result);
                    fetchedPages += 1;
                    const pageBytes = Buffer.byteLength(JSON.stringify(page.tools), 'utf8');
                    if (remoteToolBytes + pageBytes > MAX_REMOTE_TOOL_DIRECTORY_BYTES) {
                        await failIncomplete('Remote tools/list pagination exceeded the cumulative byte limit');
                    }
                    remoteTools.push(...page.tools);
                    remoteToolBytes += pageBytes;
                    for (const name of page.names) remoteToolNames.add(name);
                    if (remoteTools.length > MAX_REMOTE_TOOL_DIRECTORY_TOOLS) {
                        await failIncomplete('Remote tools/list pagination exceeded the tool limit');
                    }
                    nextCursor = page.nextCursor;
                }
                return Object.freeze({
                    names: remoteToolNames,
                    tools: Object.freeze(remoteTools),
                });
            })();
            return hydrationPromise;
        }

        return Object.freeze({ firstResult, hydrate });
    }

    let currentEpoch = createDirectoryEpoch(sessionRecord.remoteToolFirstPage);
    let refreshTail = Promise.resolve();

    async function list(params = {}) {
        const safeParams = deepFreezeJson(cloneBoundedJson(params, 'remote tool directory list params'));
        assertPlainRecord(safeParams, 'remote tool directory list params');
        if (safeParams.cursor !== undefined) return session.listTools(safeParams);

        const refresh = refreshTail.then(async () => {
            const result = await session.listTools(safeParams);
            const epoch = createDirectoryEpoch(result);
            currentEpoch = epoch;
            const snapshot = await epoch.hydrate();
            const { nextCursor: ignoredNextCursor, ...aggregate } = epoch.firstResult;
            return {
                ...aggregate,
                tools: mergeFallbackTools(snapshot.tools),
            };
        });
        refreshTail = refresh.then(
            () => undefined,
            () => undefined,
        );
        return refresh;
    }

    async function has(name) {
        const epoch = currentEpoch;
        const snapshot = await epoch.hydrate();
        return snapshot.names.has(name);
    }

    return { has, list };
}

const FALLBACK_TOOL_NAMES = new Set(buildFallbackToolList().map((tool) => tool.name));

function buildBlockedToolResult(code, message, details = {}) {
    return {
        isError: true,
        ...buildJsonContent({
            ok: false,
            error: code,
            message,
            ...details,
        }),
    };
}

function fallbackTargetUrl(path) {
    if (!AGORAGENTIC_BASE) {
        throw new McpEnforcementError(
            'MCP_FALLBACK_BASE_INVALID',
            'Set a valid AGORAGENTIC_MCP_URL or explicit AGORAGENTIC_BASE_URL before using fallback tools',
        );
    }
    const base = normalizeRemoteTarget(AGORAGENTIC_BASE);
    const baseUrl = new URL(base.href);
    if (baseUrl.pathname !== '/' || baseUrl.search) {
        throw new McpEnforcementError(
            'MCP_FALLBACK_BASE_INVALID',
            'AGORAGENTIC_BASE_URL must be an HTTP(S) origin without a path or query',
        );
    }
    return normalizeRemoteTarget(new URL(path, base.origin).href, { allowQuery: true }).href;
}

async function executeEnforcedFallback(enforcementBoundary, {
    name,
    args,
    method,
    path,
    body,
}) {
    const adapter = requireEnforcementBoundary(enforcementBoundary);
    const request = buildEnforcementRequest({
        schema: MCP_ENFORCEMENT_SCHEMAS.fallbackRequest,
        phase: 'tools/call',
        remoteUrl: fallbackTargetUrl(path),
        params: args,
        toolName: name,
        extra: {
            fallback_http: {
                method,
                path,
                body: body === undefined ? null : body,
                authentication: { mode: 'host_resolved_out_of_band' },
                user_agent: `agoragentic-mcp/${PACKAGE_VERSION}`,
            },
        },
    });
    const envelope = await adapter.executeFallback(request);
    return verifyCleanImportedResult(envelope, request);
}

async function executeFallbackTool(name, args = {}, options = {}) {
    assertExactKeys(options, ['enforcementBoundary'], 'fallback execution options');
    const safeArgs = cloneBoundedJson(args, 'fallback tool arguments');
    const enforcementBoundary = options.enforcementBoundary;

    async function enforced(request) {
        try {
            const data = await executeEnforcedFallback(enforcementBoundary, request);
            return buildJsonContent(data);
        } catch (error) {
            if (error?.code === 'MCP_RISK_FORK_ENFORCEMENT_REQUIRED') {
                return buildBlockedToolResult(
                    'risk_fork_enforcement_required',
                    'Fallback network execution is disabled until a factory-created enforcement host capability is installed.',
                    { tool: name },
                );
            }
            throw error;
        }
    }

    if (name === 'agoragentic_register') {
        const agentName = safeArgs.agent_name || safeArgs.name || 'mcp-agent';
        return enforced({
            name,
            args: safeArgs,
            method: 'POST',
            path: '/api/quickstart',
            body: {
            name: agentName,
                intent: safeArgs.intent || 'buyer',
                description: safeArgs.description || 'Registered through agoragentic-mcp fallback tools.',
            },
        });
    }

    if (name === 'agoragentic_search') {
        const params = new URLSearchParams();
        if (safeArgs.query) params.set('q', safeArgs.query);
        if (safeArgs.category) params.set('category', safeArgs.category);
        if (safeArgs.limit !== undefined) params.set('limit', String(safeArgs.limit));
        const path = `/api/capabilities?${params.toString()}`;
        return enforced({ name, args: safeArgs, method: 'GET', path });
    }

    if (name === 'agoragentic_preview_x402') {
        const task = String(safeArgs.task || '').trim();
        if (!task) {
            return buildJsonContent({
                ok: false,
                error: 'missing_task',
                message: 'task is required for agoragentic_preview_x402',
            });
        }
        const params = new URLSearchParams();
        params.set('task', task);
        if (safeArgs.max_cost !== undefined) params.set('max_cost', String(safeArgs.max_cost));
        if (safeArgs.category) params.set('category', safeArgs.category);
        if (safeArgs.max_latency_ms !== undefined) params.set('max_latency_ms', String(safeArgs.max_latency_ms));
        if (safeArgs.prefer_trusted !== undefined) params.set('prefer_trusted', safeArgs.prefer_trusted ? 'true' : 'false');
        if (safeArgs.payment_network) params.set('payment_network', safeArgs.payment_network);
        if (safeArgs.payment_asset) params.set('payment_asset', safeArgs.payment_asset);
        const path = `/api/x402/execute/match?${params.toString()}`;
        return enforced({ name, args: safeArgs, method: 'GET', path });
    }

    if (name === 'agoragentic_match') {
        const params = new URLSearchParams();
        params.set('task', safeArgs.task);
        if (safeArgs.max_cost !== undefined) params.set('max_cost', String(safeArgs.max_cost));
        if (safeArgs.category) params.set('category', safeArgs.category);
        if (safeArgs.prefer_trusted !== undefined) params.set('prefer_trusted', safeArgs.prefer_trusted ? 'true' : 'false');
        const path = `/api/execute/match?${params.toString()}`;
        return enforced({ name, args: safeArgs, method: 'GET', path });
    }

    if (name === 'agoragentic_execute') {
        const payload = {
            task: safeArgs.task,
            input: safeArgs.input || {},
            constraints: safeArgs.constraints || {},
        };
        if (safeArgs.quote_id) payload.quote_id = safeArgs.quote_id;
        if (safeArgs.intent_contract_id) payload.intent_contract_id = safeArgs.intent_contract_id;
        return enforced({
            name,
            args: safeArgs,
            method: 'POST',
            path: '/api/execute',
            body: payload,
        });
    }

    if (name === 'agoragentic_execute_status') {
        const invocationId = String(safeArgs.invocation_id || '').replace(/[^a-zA-Z0-9\-_]/g, '');
        if (!invocationId) return buildJsonContent({ ok: false, error: 'invalid_invocation_id' });
        const path = `/api/execute/status/${invocationId}`;
        return enforced({ name, args: safeArgs, method: 'GET', path });
    }

    return buildJsonContent({
        ok: false,
        error: 'unknown_tool',
        tool: name,
    });
}

async function connectRemoteClient(options = {}) {
    assertExactKeys(
        options,
        ['remoteUrl', 'enforcementBoundary', 'riskForkPlanner'],
        'connectRemoteClient options',
    );
    const remoteUrl = options.remoteUrl ?? REMOTE_MCP_URL;
    const enforcementBoundary = options.enforcementBoundary;
    const riskForkPlanner = options.riskForkPlanner;
    if (riskForkPlanner !== undefined) {
        throw new TypeError(
            'riskForkPlanner is not a supported enforcement boundary; use createMcpEnforcementBoundary()',
        );
    }
    const adapter = requireEnforcementBoundary(enforcementBoundary);
    const openRequest = buildEnforcementRequest({
        schema: MCP_ENFORCEMENT_SCHEMAS.sessionOpenRequest,
        phase: 'server/discover',
        remoteUrl,
        params: {
            protocol_version: MCP_V2_PROTOCOL_VERSION,
            stateless_required: true,
        },
    });
    const rawHostSession = await adapter.openSession(openRequest);
    const closeDescriptor = rawHostSession && typeof rawHostSession === 'object'
        ? Object.getOwnPropertyDescriptor(rawHostSession, 'close')
        : null;
    const emergencyClose = closeDescriptor?.enumerable
        && !closeDescriptor.get
        && !closeDescriptor.set
        && typeof closeDescriptor.value === 'function'
        ? closeDescriptor.value
        : null;
    let hostSession;
    let discoveryEnvelope;
    let discovery;
    try {
        assertExactKeys(
            rawHostSession,
            ['schema', 'discovery', 'request', 'close'],
            'enforced MCP host session',
        );
        if (rawHostSession.schema !== MCP_ENFORCEMENT_SCHEMAS.hostSession
            || typeof rawHostSession.request !== 'function'
            || typeof rawHostSession.close !== 'function') {
            throw new McpEnforcementError(
                'MCP_RISK_FORK_SESSION_INVALID',
                'The enforcement host did not return the closed enforced-session contract',
            );
        }
        hostSession = Object.freeze({
            discovery: rawHostSession.discovery,
            request: rawHostSession.request,
            close: rawHostSession.close,
        });
        discoveryEnvelope = verifyCleanImportedEnvelope(hostSession.discovery, openRequest);
        discovery = discoveryEnvelope.result;
        assertExactKeys(discovery, ['protocol_version', 'stateless'], 'clean discovery result');
        if (discovery.protocol_version !== MCP_V2_PROTOCOL_VERSION || discovery.stateless !== true) {
            throw new McpEnforcementError(
                'MCP_REMOTE_NEGOTIATION_REJECTED',
                `Hosted MCP did not establish an enforced stateless ${MCP_V2_PROTOCOL_VERSION} connection`,
            );
        }
    } catch (error) {
        try {
            await emergencyClose?.();
        } catch {
            // Preserve the fail-closed session/import error.
        }
        throw error;
    }

    let session;
    const record = {
        remote_url: openRequest.mcp_server_ref,
        remote_origin: openRequest.mcp_server_origin,
        session_binding_hash: sha256Ref({
            open_request_hash: openRequest.request_hash,
            discovery_evidence_hash: discoveryEnvelope.evidence_hash,
            discovery_result_hash: sha256Ref(discovery),
            protocol_version: discovery.protocol_version,
            stateless: discovery.stateless,
        }),
        hostRequest: hostSession.request,
        hostClose: hostSession.close,
        closed: false,
        closePromise: null,
        remoteToolFirstPage: null,
    };

    function close() {
        const current = enforcedSessionRecords.get(session);
        if (!current) return Promise.resolve();
        if (current.closePromise) return current.closePromise;
        current.closed = true;
        current.closePromise = Promise.resolve().then(() => current.hostClose());
        return current.closePromise;
    }

    async function request(phase, params = {}) {
        const current = enforcedSessionRecords.get(session);
        if (!current || current.closed) {
            throw new McpEnforcementError('MCP_ENFORCED_SESSION_CLOSED', 'The enforced MCP session is closed');
        }
        const safeParams = cloneBoundedJson(params, `${phase} params`);
        const phaseRequest = buildEnforcementRequest({
            schema: MCP_ENFORCEMENT_SCHEMAS.phaseRequest,
            phase,
            remoteUrl: current.remote_url,
            params: safeParams,
            toolName: phase === 'tools/call' ? safeParams.name ?? null : null,
            sessionBindingHash: current.session_binding_hash,
        });
        try {
            const envelope = await current.hostRequest(phaseRequest);
            const afterRequest = enforcedSessionRecords.get(session);
            if (afterRequest !== current || current.closed) {
                throw new McpEnforcementError(
                    'MCP_ENFORCED_SESSION_CLOSED',
                    'The enforced MCP session closed before the host result could be imported',
                );
            }
            const result = verifyCleanImportedResult(envelope, phaseRequest);
            if (phase === 'tools/list') {
                validateRemoteToolListPage(result);
                if (safeParams.cursor === undefined) current.remoteToolFirstPage = result;
            }
            return result;
        } catch (error) {
            try {
                await close();
            } catch {
                // Preserve the request/import failure.
            }
            throw error;
        }
    }

    session = Object.freeze({
        schema: MCP_ENFORCEMENT_SCHEMAS.session,
        protocol_version: MCP_V2_PROTOCOL_VERSION,
        stateless: true,
        remote_url: openRequest.mcp_server_ref,
        remote_origin: openRequest.mcp_server_origin,
        listTools: (params = {}) => request('tools/list', params),
        callTool: (params = {}) => request('tools/call', params),
        listResources: (params = {}) => request('resources/list', params),
        readResource: (params = {}) => request('resources/read', params),
        listPrompts: (params = {}) => request('prompts/list', params),
        getPrompt: (params = {}) => request('prompts/get', params),
        close,
    });
    enforcedSessionRecords.set(session, record);

    try {
        await session.listTools();
        return session;
    } catch (error) {
        try {
            await close();
        } catch {
            // Preserve the first enforced-session failure.
        }
        throw error;
    }
}

async function closeRemoteSession(remoteSession) {
    if (!remoteSession) return;
    if (!enforcedSessionRecords.has(remoteSession)) {
        throw new TypeError('remoteSession must be an opaque enforced MCP session');
    }
    await remoteSession.close();
}

async function runMcpRelay({ enforcementBoundary } = {}) {
    const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
    const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
    const {
        CallToolRequestSchema,
        ListToolsRequestSchema,
        ListResourcesRequestSchema,
        ReadResourceRequestSchema,
        ListPromptsRequestSchema,
        GetPromptRequestSchema,
    } = require('@modelcontextprotocol/sdk/types.js');

    const server = new Server(
        { name: 'agoragentic', version: PACKAGE_VERSION },
        { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );

    let remoteSession = null;
    try {
        remoteSession = await connectRemoteClient({ enforcementBoundary });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[agoragentic-mcp] remote relay unavailable; exposing fail-closed local tool metadata only: ${message}`);
    }

    if (remoteSession) {
        const remoteTools = createRemoteToolDirectory(remoteSession);

        server.setRequestHandler(ListToolsRequestSchema, async (request) => {
            return remoteTools.list(request.params);
        });

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            if (FALLBACK_TOOL_NAMES.has(request.params.name) && !(await remoteTools.has(request.params.name))) {
                return executeFallbackTool(request.params.name, request.params.arguments || {}, {
                    enforcementBoundary,
                });
            }
            return remoteSession.callTool(request.params);
        });

        server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
            return remoteSession.listResources(request.params);
        });

        server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            return remoteSession.readResource(request.params);
        });

        server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
            return remoteSession.listPrompts(request.params);
        });

        server.setRequestHandler(GetPromptRequestSchema, async (request) => {
            return remoteSession.getPrompt(request.params);
        });
    } else {
        server.setRequestHandler(ListToolsRequestSchema, async () => {
            return { tools: buildFallbackToolList() };
        });

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            return executeFallbackTool(request.params.name, request.params.arguments || {}, {
                enforcementBoundary,
            });
        });

        server.setRequestHandler(ListResourcesRequestSchema, async () => {
            return { resources: [] };
        });

        server.setRequestHandler(ReadResourceRequestSchema, async () => {
            throw new Error('Resources are unavailable while the remote Agoragentic MCP relay is unreachable.');
        });

        server.setRequestHandler(ListPromptsRequestSchema, async () => {
            return { prompts: [] };
        });

        server.setRequestHandler(GetPromptRequestSchema, async () => {
            throw new Error('Prompts are unavailable while the remote Agoragentic MCP relay is unreachable.');
        });
    }

    let shutdownPromise = null;
    const shutdown = (reason) => {
        if (shutdownPromise) return shutdownPromise;
        console.error(`[agoragentic-mcp] shutting down on ${reason}`);
        shutdownPromise = (async () => {
            let firstError = null;
            try {
                await closeRemoteSession(remoteSession);
            } catch (error) {
                firstError = error;
            }
            try {
                await server.close();
            } catch (error) {
                firstError ??= error;
            }
            if (firstError) throw firstError;
        })();
        return shutdownPromise;
    };

    function terminateAfterShutdown(reason) {
        void shutdown(reason).then(
            () => process.exit(0),
            (error) => {
                const message = error instanceof Error ? error.stack || error.message : String(error);
                console.error(`[agoragentic-mcp] shutdown failed: ${message}`);
                process.exit(1);
            },
        );
    }

    process.once('SIGINT', () => terminateAfterShutdown('SIGINT'));
    process.once('SIGTERM', () => terminateAfterShutdown('SIGTERM'));
    process.stdin.once('end', () => terminateAfterShutdown('stdin EOF'));
    process.stdin.once('close', () => terminateAfterShutdown('stdin close'));

    const stdio = new StdioServerTransport(undefined, undefined, {
        maxBufferSize: MAX_ENFORCEMENT_JSON_BYTES,
    });
    await server.connect(stdio);
    if (process.stdin.readableEnded || process.stdin.destroyed) {
        terminateAfterShutdown('closed stdin');
    }

    if (remoteSession) {
        console.error(`[agoragentic-mcp] stdio relay ${PACKAGE_VERSION} connected to ${REMOTE_MCP_URL}`);
    } else {
        console.error(`[agoragentic-mcp] stdio adapter ${PACKAGE_VERSION} is fail-closed; desired fallback origin is ${AGORAGENTIC_BASE}`);
    }
}

function buildAcpInitializeResult() {
    return {
        protocolVersion: 1,
        agentInfo: {
            name: 'Agoragentic Agent OS',
            version: PACKAGE_VERSION,
            description:
                'Fail-closed Agent OS protocol adapter. Network calls require a separately qualified embedding-host enforcement implementation.',
            homepage: 'https://agoragentic.com',
        },
        agentCapabilities: {
            tools: true,
            streaming: false,
            resources: false,
            prompts: false,
            loadSession: false,
            promptCapabilities: {
                image: false,
            },
        },
        authMethods: [],
    };
}

function buildAcpResponse(id, result) {
    return {
        jsonrpc: '2.0',
        id,
        result,
    };
}

function buildAcpError(id, code, message, data) {
    return {
        jsonrpc: '2.0',
        id,
        error: data ? { code, message, data } : { code, message },
    };
}

function writeAcpMessage(message) {
    const serialized = `${JSON.stringify(message)}\n`;
    return new Promise((resolve, reject) => {
        process.stdout.write(serialized, (error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

function buildAcpSessionId() {
    return `sess_${crypto.randomBytes(12).toString('hex')}`;
}

function extractAcpPromptText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((part) => {
            if (!part || typeof part !== 'object') return '';
            if (part.type === 'text' && typeof part.text === 'string') return part.text;
            return '';
        })
        .filter(Boolean)
        .join('\n');
}

function buildAcpPromptReply(promptText) {
    const suffix = promptText ? ` Prompt received: ${promptText.slice(0, 240)}` : '';
    return [
        'Agoragentic Agent Client Protocol adapter is a tool bridge, not a code-editing chat agent.',
        'Use tools/list before tools/call. Network-backed tool calls remain blocked unless an embedding host supplies a separately qualified enforcement implementation.',
        suffix,
    ]
        .filter(Boolean)
        .join(' ');
}

async function runAcpAdapter({ enforcementBoundary } = {}) {
    let remoteSession = null;
    let remoteConnectionPromise = null;
    let remoteShutdownPromise = null;
    let shuttingDown = false;
    const acpSessions = new Map();

    async function getRemoteSession() {
        if (shuttingDown) {
            throw new McpEnforcementError(
                'MCP_ACP_ADAPTER_SHUT_DOWN',
                'The Agent Client Protocol adapter is shut down',
            );
        }
        if (remoteSession) return remoteSession;
        if (!remoteConnectionPromise) {
            remoteConnectionPromise = connectRemoteClient({ enforcementBoundary });
        }
        let connected;
        try {
            connected = await remoteConnectionPromise;
        } catch (error) {
            remoteConnectionPromise = null;
            throw error;
        }
        if (shuttingDown) {
            await shutdownRemote();
            throw new McpEnforcementError(
                'MCP_ACP_ADAPTER_SHUT_DOWN',
                'The Agent Client Protocol adapter shut down during remote discovery',
            );
        }
        remoteSession = connected;
        return remoteSession;
    }

    function shutdownRemote() {
        if (remoteShutdownPromise) return remoteShutdownPromise;
        remoteShutdownPromise = (async () => {
            let session = remoteSession;
            if (!session && remoteConnectionPromise) {
                try {
                    session = await remoteConnectionPromise;
                } catch {
                    return;
                }
            }
            remoteSession = null;
            if (session) await closeRemoteSession(session);
        })();
        return remoteShutdownPromise;
    }

    function beginShutdown() {
        shuttingDown = true;
        acpSessions.clear();
        return shutdownRemote();
    }

    function terminateAfterShutdown() {
        void beginShutdown().then(
            () => process.exit(0),
            (error) => {
                const message = error instanceof Error ? error.stack || error.message : String(error);
                console.error(`[agoragentic-mcp] ACP shutdown failed: ${message}`);
                process.exit(1);
            },
        );
    }

    process.once('SIGINT', terminateAfterShutdown);
    process.once('SIGTERM', terminateAfterShutdown);

    console.error(`[agoragentic-mcp] Agent Client Protocol adapter ${PACKAGE_VERSION} ready; network calls require an embedding-host enforcement capability`);

    for await (const lineRecord of readBoundedLines(
        process.stdin,
        MAX_ENFORCEMENT_JSON_BYTES,
        'Agent Client Protocol JSON-RPC payload',
    )) {
        if (lineRecord.error) {
            await writeAcpMessage(buildAcpError(
                null,
                -32600,
                'Invalid or unsafe JSON-RPC payload',
            ));
            continue;
        }
        const line = lineRecord.text;
        if (!line.trim()) continue;

        let request;
        try {
            request = parseBoundedPlainJson(line, 'Agent Client Protocol JSON-RPC payload');
        } catch (error) {
            const code = error instanceof SyntaxError ? -32700 : -32600;
            const message = code === -32700
                ? 'Invalid JSON-RPC payload'
                : 'Invalid or unsafe JSON-RPC payload';
            await writeAcpMessage(buildAcpError(null, code, message));
            continue;
        }

        const hasId = Object.prototype.hasOwnProperty.call(request, 'id');
        const id = hasId ? request.id : null;

        async function writeResponse(message) {
            if (hasId) await writeAcpMessage(message);
        }

        if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
            await writeResponse(buildAcpError(id, -32600, 'Invalid JSON-RPC request'));
            continue;
        }
        if (request.params !== undefined && request.params !== null) {
            try {
                assertPlainRecord(request.params, 'Agent Client Protocol JSON-RPC params');
            } catch {
                await writeResponse(buildAcpError(id, -32602, 'Agent Client Protocol params must be an object'));
                continue;
            }
        }
        if (shuttingDown) {
            await writeResponse(buildAcpError(
                id,
                -32000,
                'The Agent Client Protocol adapter is shut down',
                { enforcement_code: 'MCP_ACP_ADAPTER_SHUT_DOWN' },
            ));
            continue;
        }

        try {
            if (request.method === 'initialize') {
                await writeResponse(buildAcpResponse(id, buildAcpInitializeResult()));
            } else if (request.method === 'session/new') {
                if (acpSessions.size >= MAX_ACP_SESSIONS) {
                    await writeResponse(buildAcpError(id, -32000, 'Agent Client Protocol session limit reached'));
                    continue;
                }
                const requestedCwd = request.params?.cwd;
                if (requestedCwd !== undefined && (
                    typeof requestedCwd !== 'string'
                    || requestedCwd.length === 0
                    || requestedCwd.length > MAX_ACP_CWD_LENGTH
                    || requestedCwd.includes('\0')
                )) {
                    await writeResponse(buildAcpError(
                        id,
                        -32602,
                        `Agent Client Protocol cwd must be a nonempty string of at most ${MAX_ACP_CWD_LENGTH} characters`,
                    ));
                    continue;
                }
                const sessionId = buildAcpSessionId();
                acpSessions.set(sessionId, {
                    cwd: requestedCwd ?? process.cwd(),
                    createdAt: new Date().toISOString(),
                    cancelled: false,
                });
                await writeResponse(buildAcpResponse(id, { sessionId }));
            } else if (request.method === 'session/prompt') {
                const sessionId = request.params?.sessionId;
                if (!sessionId || !acpSessions.has(sessionId)) {
                    await writeResponse(buildAcpError(id, -32602, 'Unknown or missing Agent Client Protocol sessionId'));
                    continue;
                }

                const session = acpSessions.get(sessionId);
                session.cancelled = false;
                const promptText = extractAcpPromptText(request.params?.content);
                const reply = buildAcpPromptReply(promptText);

                await writeAcpMessage({
                    jsonrpc: '2.0',
                    method: 'session/update',
                    params: {
                        sessionId,
                        update: {
                            sessionUpdate: 'agent_message_chunk',
                            content: {
                                type: 'text',
                                text: reply,
                            },
                        },
                    },
                });
                await writeResponse(buildAcpResponse(id, { stopReason: session.cancelled ? 'cancelled' : 'end_turn' }));
            } else if (request.method === 'session/cancel') {
                const sessionId = request.params?.sessionId;
                if (sessionId && acpSessions.has(sessionId)) {
                    acpSessions.get(sessionId).cancelled = true;
                }
                await writeResponse(buildAcpResponse(id, { ok: true }));
            } else if (request.method === 'tools/list') {
                await writeResponse(buildAcpResponse(id, { tools: ACP_TOOLS }));
            } else if (request.method === 'tools/call') {
                const toolName = request.params?.name;
                if (!ACP_TOOL_NAMES.has(toolName)) {
                    await writeResponse(buildAcpError(id, -32602, 'Tool is not advertised by this Agent Client Protocol adapter'));
                    continue;
                }
                const session = await getRemoteSession();
                const result = await session.callTool(request.params || {});
                await writeResponse(buildAcpResponse(id, result));
            } else if (request.method === 'shutdown') {
                await beginShutdown();
                await writeResponse(buildAcpResponse(id, { ok: true }));
            } else {
                await writeResponse(
                    buildAcpError(id, -32601, 'Unsupported Agent Client Protocol method', {
                        supported_methods: [
                            'initialize',
                            'session/new',
                            'session/prompt',
                            'session/cancel',
                            'tools/list',
                            'tools/call',
                            'shutdown',
                        ],
                    })
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const data = error instanceof McpEnforcementError
                ? { enforcement_code: error.code }
                : undefined;
            await writeResponse(buildAcpError(id, -32000, message, data));
        }
    }

    await beginShutdown();
}

const entrypoint = ACP_MODE ? runAcpAdapter : runMcpRelay;

if (require.main === module) {
    entrypoint().catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`[agoragentic-mcp] fatal: ${message}`);
        process.exit(1);
    });
}

module.exports = {
    MCP_ENFORCEMENT_SCHEMAS,
    MCP_V2_PROTOCOL_VERSION,
    buildFallbackToolList,
    closeRemoteSession,
    computeMcpCleanImportEvidenceHash,
    connectRemoteClient,
    createMcpEnforcementBoundary,
    createRemoteToolDirectory,
    executeFallbackTool,
    runAcpAdapter,
    runMcpRelay,
};
