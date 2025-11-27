/**
 * Agent config types matching vm0.config.yaml format
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
 * Agent definition within the agents array
 */
export interface AgentDefinition {
  name: string; // Unique identifier per user
  description?: string;
  image: string;
  provider: string;
  volumes?: string[]; // Format: "volume-key:/mount/path"
  working_dir: string; // Working directory for artifact mount
}

export interface AgentConfigYaml {
  version: string;
  agents: AgentDefinition[]; // Array of agent definitions (currently only first is processed)
  volumes?: Record<string, VolumeConfig>; // Volume definitions with name and version
}

/**
 * Database record type
 */
export interface AgentConfigRecord {
  id: string;
  apiKeyId: string;
  config: AgentConfigYaml;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * API request/response types
 */
export interface CreateAgentConfigRequest {
  config: AgentConfigYaml;
}

export interface CreateAgentConfigResponse {
  configId: string;
  name: string;
  action: "created" | "updated";
  createdAt?: string;
  updatedAt?: string;
}

export interface GetAgentConfigResponse {
  id: string;
  name: string;
  config: AgentConfigYaml;
  createdAt: string;
  updatedAt: string;
}
