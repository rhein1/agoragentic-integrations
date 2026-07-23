'use strict';

const spec = require('./agent-toolkit.generated.json');

function getAgentToolkitSpec() {
    return JSON.parse(JSON.stringify(spec));
}

function listToolkitCommands() {
    return getAgentToolkitSpec().commands;
}

function listToolkitMcpTools() {
    return getAgentToolkitSpec().mcp_tools;
}

function listWorkflowSkills() {
    return getAgentToolkitSpec().workflow_skills;
}

function getExportTarget(target) {
    if (!target) return null;
    return getAgentToolkitSpec().export_targets[String(target).toLowerCase()] || null;
}

module.exports = {
    getAgentToolkitSpec,
    listToolkitCommands,
    listToolkitMcpTools,
    listWorkflowSkills,
    getExportTarget,
};
