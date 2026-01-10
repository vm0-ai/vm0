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
 * Firewall rule for network egress control
 *
 * Rules can be either:
 * - Domain/IP rule: { domain: "*.example.com", action: "ALLOW" }
 * - Terminal rule: { final: "DENY" }
 */
export interface FirewallRule {
  /** Domain pattern (e.g., "github.com", "*.anthropic.com") */
  domain?: string;
  /** IP address or CIDR range (e.g., "1.2.3.4", "10.0.0.0/8") */
  ip?: string;
  /** Terminal rule - value is the action (ALLOW or DENY) */
  final?: "ALLOW" | "DENY";
  /** Action for domain/ip rules */
  action?: "ALLOW" | "DENY";
}

/**
 * Experimental firewall configuration for network egress control
 * Requires experimental_runner to be configured
 */
export interface ExperimentalFirewall {
  /** Enable firewall filtering */
  enabled: boolean;
  /** Firewall rules (evaluated top to bottom, first-match-wins) */
  rules?: FirewallRule[];
  /** Enable HTTPS inspection via MITM (routes traffic through Platform Proxy) */
  experimental_mitm?: boolean;
  /** Encrypt secrets in VM environment (requires experimental_mitm) */
  experimental_seal_secrets?: boolean;
}

/**
 * Agent definition within the agents dictionary
 * The agent name is the key in the dictionary, not a field
 */
export interface AgentDefinition {
  description?: string;
  image?: string; // Optional when provider supports auto-config
  provider: string;
  volumes?: string[]; // Format: "volume-key:/mount/path"
  working_dir?: string; // Optional when provider supports auto-config
  environment?: Record<string, string>; // Environment variables using ${{ vars.X }}, ${{ secrets.X }} syntax
  /**
   * Path to instructions file (e.g., AGENTS.md).
   * Auto-uploaded as volume and mounted at /home/user/.claude/CLAUDE.md
   */
  instructions?: string;
  /**
   * Array of GitHub tree URLs for agent skills.
   * Each skill is auto-downloaded and mounted at /home/user/.claude/skills/{skillName}/
   * Format: https://github.com/{owner}/{repo}/tree/{branch}/{path}
   */
  skills?: string[];
  /**
   * Route this agent to a self-hosted runner instead of E2B.
   * When specified, runs will be queued for the specified runner group.
   */
  experimental_runner?: {
    group: string;
  };
  /**
   * Experimental firewall configuration for network egress control.
   * Requires experimental_runner to be configured.
   * When enabled, filters outbound traffic by domain/IP rules.
   */
  experimental_firewall?: ExperimentalFirewall;
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
