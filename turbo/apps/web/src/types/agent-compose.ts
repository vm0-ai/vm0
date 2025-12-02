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
 * Database record type for compose metadata
 */
export interface AgentComposeRecord {
  id: string;
  userId: string;
  name: string;
  headVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Database record type for compose version (immutable)
 */
export interface AgentComposeVersionRecord {
  id: string; // SHA-256 hash
  composeId: string;
  content: AgentComposeYaml;
  createdBy: string;
  createdAt: Date;
}

/**
 * API request/response types
 */
export interface CreateAgentComposeRequest {
  content: AgentComposeYaml;
}

export interface CreateAgentComposeResponse {
  composeId: string;
  name: string;
  versionId: string;
  action: "created" | "existing";
  createdAt?: string;
  updatedAt?: string;
}

export interface GetAgentComposeResponse {
  id: string;
  name: string;
  headVersionId: string | null;
  content: AgentComposeYaml | null; // null if no versions exist
  createdAt: string;
  updatedAt: string;
}

/**
 * Response type for getting a specific version
 */
export interface GetAgentComposeVersionResponse {
  versionId: string;
  composeId: string;
  composeName: string;
  content: AgentComposeYaml;
  createdBy: string;
  createdAt: string;
}
