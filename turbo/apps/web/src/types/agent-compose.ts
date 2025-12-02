/**
 * Agent compose types matching agent.yaml format
 */

/**
 * Volume configuration for static dependencies
 * Each volume requires explicit name and version
 */
export interface VolumeConfig {
  name: string; // Required: actual storage name
  version: string; // Required: version hash or "latest"
}

/**
 * Agent definition within the agents dictionary
 * The agent name is the key in the dictionary, not a field
 */
export interface AgentDefinition {
  description?: string;
  image: string;
  provider: string;
  volumes?: string[]; // Format: "volume-key:/mount/path"
  working_dir: string; // Working directory for artifact mount
}

export interface AgentComposeYaml {
  version: string;
  agents: Record<string, AgentDefinition>; // Dictionary of agent definitions (currently only one agent supported)
  volumes?: Record<string, VolumeConfig>; // Volume definitions with name and version
}

/**
 * Database record type
 */
export interface AgentComposeRecord {
  id: string;
  apiKeyId: string;
  config: AgentComposeYaml;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * API request/response types
 */
export interface CreateAgentComposeRequest {
  config: AgentComposeYaml;
}

export interface CreateAgentComposeResponse {
  composeId: string;
  name: string;
  action: "created" | "updated";
  createdAt?: string;
  updatedAt?: string;
}

export interface GetAgentComposeResponse {
  id: string;
  name: string;
  config: AgentComposeYaml;
  createdAt: string;
  updatedAt: string;
}
