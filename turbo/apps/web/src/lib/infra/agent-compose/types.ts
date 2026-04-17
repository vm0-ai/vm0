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
  /** When true, skip mounting without error if volume doesn't exist */
  optional?: boolean;
  /** When true, resolve SYSTEM_ORG first, agent org as fallback */
  system?: boolean;
}

/**
 * Agent definition within the agents dictionary
 * The agent name is the key in the dictionary, not a field
 */
interface AgentDefinition {
  description?: string;
  framework: string;
  volumes?: string[]; // Format: "volume-key:/mount/path"
  environment?: Record<string, string>; // Environment variables using ${{ vars.X }}, ${{ secrets.X }} syntax
  /**
   * Path to instructions file (e.g., AGENTS.md).
   * Auto-uploaded as volume and mounted at /home/user/.claude/CLAUDE.md
   */
  instructions?: string;
  /**
   * Route this agent to a self-hosted runner instead of E2B.
   * When specified, runs will be queued for the specified runner group.
   */
  experimental_runner?: {
    group: string;
  };
  /**
   * VM profile for resource allocation (e.g., "vm0/default").
   * Determines rootfs image and VM resources (vCPU, memory).
   * Defaults to "vm0/default" when omitted.
   */
  experimental_profile?: string;
}

export interface AgentComposeYaml {
  version: string;
  agents: Record<string, AgentDefinition>; // Dictionary of agent definitions (currently only one agent supported)
  volumes?: Record<string, VolumeConfig>; // Volume definitions with name and version
}
