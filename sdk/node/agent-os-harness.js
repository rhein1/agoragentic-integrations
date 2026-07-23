'use strict';

const spec = require('./agent-os-harness.generated.json');

function cloneSpec() {
    return JSON.parse(JSON.stringify(spec));
}

function getAgentOsHarnessSpec() {
    return cloneSpec();
}

function listAgentOsHarnessFunnel() {
    return cloneSpec().intended_funnel;
}

function getAgentOsHarnessExamplePacket() {
    return cloneSpec().packet_schema.example;
}

function listAgentOsHarnessPolicySections() {
    return cloneSpec().policy_sections;
}

module.exports = {
    getAgentOsHarnessSpec,
    listAgentOsHarnessFunnel,
    getAgentOsHarnessExamplePacket,
    listAgentOsHarnessPolicySections,
};
