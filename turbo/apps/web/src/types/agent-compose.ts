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
  working_dir?: string; // Optional when provider supports auto-config
  environment?: Record<string, string>; // Environment variables using ${{ vars.X }}, ${{ secrets.X }} syntax
  /**
   * Enable network security mode for secrets.
   * When true, secrets are encrypted into proxy tokens and all traffic
   * is routed through mitmproxy -> VM0 Proxy for decryption.
   * Default: false (plaintext secrets in env vars)
   */
  beta_network_security?: boolean;
  /**
   * Path to system prompt file (e.g., AGENTS.md).
   * Auto-uploaded as volume and mounted at /home/user/.claude/CLAUDE.md
   * Beta feature: field name may change in future versions.
   */
  beta_system_prompt?: string;
  /**
   * Array of GitHub tree URLs for system skills.
   * Each skill is auto-downloaded and mounted at /home/user/.claude/skills/{skillName}/
   * Format: https://github.com/{owner}/{repo}/tree/{branch}/{path}
   * Beta feature: field name may change in future versions.
   */
  beta_system_skills?: string[];
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
