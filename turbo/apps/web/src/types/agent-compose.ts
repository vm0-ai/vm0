/**
 * Agent compose types matching agent.yaml format
 */

import type { ExpandedServiceConfig } from "@vm0/core";

/**
 * Volume configuration for static dependencies
 * Each volume requires explicit name and version
 */
export interface VolumeConfig {
  name: string; // Required: actual storage name
  version: string; // Required: version hash or "latest"
  /** When true, skip mounting without error if volume doesn't exist */
  optional?: boolean;
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
}

/**
 * Agent definition within the agents dictionary
 * The agent name is the key in the dictionary, not a field
 */
interface AgentDefinition {
  description?: string;
  image?: string; // Optional when framework supports auto-config
  framework: string;
  volumes?: string[]; // Format: "volume-key:/mount/path"
  working_dir?: string; // Optional when framework supports auto-config
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
  /**
   * Expanded service configs for proxy-side token replacement.
   * Resolved from service names at compose time, stored as full objects.
   * Input format (CLI): string[] — expanded server-side before storage.
   */
  experimental_services?: ExpandedServiceConfig[];
  /**
   * Agent metadata for display and personalization.
   */
  metadata?: {
    displayName?: string;
    description?: string;
    sound?: string;
  };
}

export interface AgentComposeYaml {
  version: string;
  agents: Record<string, AgentDefinition>; // Dictionary of agent definitions (currently only one agent supported)
  volumes?: Record<string, VolumeConfig>; // Volume definitions with name and version
}
