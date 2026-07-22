export interface AgentOsHarnessSpec {
  schema_version: string;
  generated_from: Record<string, unknown>;
  contract: Record<string, unknown>;
  intended_funnel: Array<Record<string, unknown>>;
  public_components: Array<Record<string, unknown>>;
  micro_ecf_adoption_boundary: Record<string, unknown>;
  policy_sections: Array<Record<string, unknown>>;
  packet_schema: Record<string, unknown>;
  agent_os_export: Record<string, unknown>;
  first_proof_contract: Record<string, unknown>;
  commerce_activation_paths: Record<string, unknown>;
  required_safety_properties: Record<string, unknown>;
  private_components_not_distributed: string[];
  packaging_guidance: string[];
}

export function getAgentOsHarnessSpec(): AgentOsHarnessSpec;
export function listAgentOsHarnessFunnel(): Array<Record<string, unknown>>;
export function getAgentOsHarnessExamplePacket(): Record<string, unknown>;
export function listAgentOsHarnessPolicySections(): Array<Record<string, unknown>>;
