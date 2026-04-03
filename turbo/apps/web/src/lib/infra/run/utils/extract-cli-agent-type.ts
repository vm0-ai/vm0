import type { AgentComposeYaml } from "../../agent-compose/types";

/**
 * Extract CLI agent type (framework) from agent compose config
 *
 * @param config Agent compose configuration
 * @returns CLI agent type string (defaults to "claude-code")
 */
export function extractCliAgentType(config: unknown): string {
  const compose = config as AgentComposeYaml | undefined;
  if (!compose?.agents) return "claude-code";
  const agents = Object.values(compose.agents);
  return agents[0]?.framework || "claude-code";
}
