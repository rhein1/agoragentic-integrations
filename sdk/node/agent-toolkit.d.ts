export interface AgentToolkitCommand {
  id: string;
  command: string;
  group: string;
  summary: string;
  safety: string;
  auth: boolean | string;
  method: string | null;
  path: string | null;
  endpoint_note: string | null;
}

export interface AgentToolkitMcpTool {
  name: string;
  command_id: string;
  method: string | null;
  path: string | null;
  auth: boolean | string;
}

export interface AgentToolkitWorkflowSkill {
  id: string;
  title: string;
  trigger: string;
  commands: string[];
}

export interface AgentToolkitExportTarget {
  unit: string;
  required_fields: string[];
  note: string;
}

export interface AgentToolkitSpec {
  schema_version: string;
  generated_from: Record<string, unknown>;
  platform: Record<string, unknown>;
  package: Record<string, unknown>;
  auth: Record<string, unknown>;
  payment: Record<string, unknown>;
  commands: AgentToolkitCommand[];
  mcp_tools: AgentToolkitMcpTool[];
  workflow_skills: AgentToolkitWorkflowSkill[];
  export_targets: Record<string, AgentToolkitExportTarget>;
  safety: Record<string, unknown>;
}

export function getAgentToolkitSpec(): AgentToolkitSpec;
export function listToolkitCommands(): AgentToolkitCommand[];
export function listToolkitMcpTools(): AgentToolkitMcpTool[];
export function listWorkflowSkills(): AgentToolkitWorkflowSkill[];
export function getExportTarget(target: string): AgentToolkitExportTarget | null;
