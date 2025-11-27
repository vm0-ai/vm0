/**
 * Agent config types matching vm0.config.yaml format
 */

/**
 * Artifact configuration for agent work products
 * Artifact is mounted at working_dir and versioned after each run
 */
export interface ArtifactConfig {
  working_dir: string;
  driver?: "vas"; // default: vas
}

/**
 * Volume configuration for static dependencies
 * Volumes are referenced by key and looked up at runtime
 */
export interface VolumeConfig {
  driver: "vas";
  driver_opts: {
    uri: string; // vas://volume-name format
  };
}

export interface AgentConfigYaml {
  version: string;
  agent: {
    name: string; // Unique identifier per user
    description?: string;
    image: string;
    provider: string;
    volumes?: string[]; // Format: "volume-key:/mount/path"
    artifact?: ArtifactConfig; // Optional work artifact
  };
  volumes?: Record<string, VolumeConfig>; // Static volume definitions
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
