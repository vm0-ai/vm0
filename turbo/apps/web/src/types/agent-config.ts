/**
 * Agent config types matching vm0.config.yaml format
 */

export interface AgentConfigYaml {
  version: string;
  agent: {
    name: string; // Unique identifier per user
    description: string;
    image: string;
    provider: string;
    working_dir: string;
    volumes: string[];
  };
  volumes?: Record<string, VolumeConfig>;
  dynamic_volumes?: Record<string, VolumeConfig>;
}

export interface VolumeConfig {
  driver: string;
  driver_opts: {
    uri: string;
    region: string;
  };
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
