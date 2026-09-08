#!/usr/bin/env node
'use strict';

const { types: { isProxy } } = require('node:util');

const SERVICE_SCHEMA = 'agoragentic.risk-forkd.service.v1';
const STATUS_SCHEMA = 'agoragentic.risk-forkd.status.v1';
const SERVICE_MODE = 'source_only_default_off';
const serviceRecords = new WeakMap();

function fail(code, message) {
    const error = new TypeError(message);
    error.code = code;
    return error;
}

function readExactOptions(options) {
    let descriptors;
    try {
        if (options === null
            || typeof options !== 'object'
            || isProxy(options)
            || Array.isArray(options)
            || Object.getPrototypeOf(options) !== Object.prototype) {
            throw new TypeError('not a plain object');
        }
        descriptors = Object.getOwnPropertyDescriptors(options);
    } catch {
        throw fail(
            'RISK_FORKD_CONFIGURATION_INVALID',
            'risk-forkd options must be a plain data-only object',
        );
    }

    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== 1 || keys[0] !== 'enforcementBoundary') {
        throw fail(
            'RISK_FORKD_CONFIGURATION_INVALID',
            'risk-forkd options must contain exactly enforcementBoundary',
        );
    }
    const descriptor = descriptors.enforcementBoundary;
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw fail(
            'RISK_FORKD_CONFIGURATION_INVALID',
            'risk-forkd enforcementBoundary must be a data property',
        );
    }
    return descriptor.value;
}

function loadMcpRuntime() {
    // The checked-in source CLI remains diagnostic-only. A source build creates
    // this bundle, and the packed subpath shares its module-private boundary
    // brand with the package main entrypoint.
    return require('./dist/mcp-server.cjs');
}

function assertExactBoundary(runtime, boundary) {
    if (!runtime.isMcpEnforcementBoundary(boundary)) {
        throw fail(
            'RISK_FORKD_ENFORCEMENT_BOUNDARY_REQUIRED',
            'risk-forkd requires an exact factory-created MCP enforcement boundary from this package instance',
        );
    }

    const descriptors = Object.getOwnPropertyDescriptors(boundary);
    const keys = Reflect.ownKeys(descriptors);
    const schema = descriptors.schema;
    const mode = descriptors.mode;
    if (Object.getPrototypeOf(boundary) !== Object.prototype
        || !Object.isFrozen(boundary)
        || keys.length !== 2
        || keys[0] !== 'schema'
        || keys[1] !== 'mode'
        || !schema
        || !Object.prototype.hasOwnProperty.call(schema, 'value')
        || schema.value !== runtime.MCP_ENFORCEMENT_SCHEMAS.boundary
        || !mode
        || !Object.prototype.hasOwnProperty.call(mode, 'value')
        || mode.value !== 'host_owns_network_and_clean_import') {
        throw fail(
            'RISK_FORKD_ENFORCEMENT_BOUNDARY_INVALID',
            'risk-forkd received a branded boundary with an unexpected public interface',
        );
    }
}

function buildStatus(enforcementBoundaryBound) {
    return Object.freeze({
        schema: STATUS_SCHEMA,
        service: 'risk-forkd',
        mode: SERVICE_MODE,
        source_candidate: true,
        default_on: false,
        mcp_enforcement_boundary_bound: enforcementBoundaryBound,
        mcp_http_phase_executor_bound: false,
        risk_fork_provider_qualified: false,
        provider_authority_granted: false,
        hosted_runtime_qualified: false,
        hosted_authority_granted: false,
        e2b_live_qualified: false,
        e2b_authority_granted: false,
        production_authority_granted: false,
        authority_granted: false,
        live_traffic_protected: false,
        network_implementation_included: false,
        commit_prepared_supported: false,
    });
}

const RISK_FORKD_DIAGNOSTIC = buildStatus(false);

function createRiskForkdService(options) {
    const enforcementBoundary = readExactOptions(options);
    const runtime = loadMcpRuntime();
    if (!Object.isFrozen(runtime)
        || typeof runtime.isMcpEnforcementBoundary !== 'function'
        || typeof runtime.runMcpRelay !== 'function') {
        throw fail(
            'RISK_FORKD_RUNTIME_INCOMPATIBLE',
            'risk-forkd requires the matching fail-closed MCP runtime',
        );
    }
    assertExactBoundary(runtime, enforcementBoundary);

    const status = buildStatus(true);
    const service = Object.freeze({
        schema: SERVICE_SCHEMA,
        mode: SERVICE_MODE,
        status,
        start: async function start() {
            if (arguments.length !== 0) {
                throw fail(
                    'RISK_FORKD_START_ARGUMENTS_UNSUPPORTED',
                    'risk-forkd start does not accept runtime overrides',
                );
            }
            const record = serviceRecords.get(service);
            if (!record || record.started) {
                throw fail(
                    'RISK_FORKD_ALREADY_STARTED',
                    'risk-forkd service instances are single-start',
                );
            }
            record.started = true;
            await record.runMcpRelay({ enforcementBoundary: record.enforcementBoundary });
        },
    });
    serviceRecords.set(service, {
        enforcementBoundary,
        runMcpRelay: runtime.runMcpRelay,
        started: false,
    });
    return service;
}

function emitStandaloneDiagnostic() {
    const diagnostic = {
        ...RISK_FORKD_DIAGNOSTIC,
        startup: 'refused',
        reason_code: 'RISK_FORKD_IN_PROCESS_BOUNDARY_REQUIRED',
        message: 'Standalone risk-forkd startup is disabled. An embedding owner must create and inject the exact in-process MCP enforcement boundary.',
    };
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    process.exitCode = 78;
}

if (require.main === module) emitStandaloneDiagnostic();

module.exports = Object.freeze({
    RISK_FORKD_DIAGNOSTIC,
    createRiskForkdService,
});
