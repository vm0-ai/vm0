/**
 * Shared types for agent compose content
 *
 * These types represent the structure of agent compose configurations
 * as returned by the API and used across CLI commands.
 */

/**
 * Agent definition from compose content
 */
export interface AgentDefinition {
  description?: string;
  framework: string;
  apps?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  instructions?: string;
  skills?: string[];
  experimental_runner?: {
    group: string;
  };
  experimental_firewall?: unknown;
  /** @deprecated Server-resolved field */
  image?: string;
  /** @deprecated Server-resolved field */
  working_dir?: string;
}

/**
 * Volume configuration from compose content
 */
export interface VolumeConfig {
  name: string;
  version: string;
}

/**
 * Agent compose content structure
 */
export interface AgentComposeContent {
  version: string;
  agents: Record<string, AgentDefinition>;
  volumes?: Record<string, VolumeConfig>;
}
