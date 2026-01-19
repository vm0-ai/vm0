import { BadRequestError } from "../../errors";
import type { AgentComposeYaml } from "../../../types/agent-compose";

/**
 * Extract working directory from agent config
 * Throws BadRequestError if working_dir is not configured
 *
 * @param config Agent compose configuration
 * @returns Working directory path
 * @throws BadRequestError if working_dir is not configured
 */
export function extractWorkingDir(config: unknown): string {
  const compose = config as AgentComposeYaml | undefined;
  if (!compose?.agents) {
    throw new BadRequestError(
      "Agent compose must have agents configured with working_dir",
    );
  }
  const agents = Object.values(compose.agents);
  const firstAgent = agents[0];
  if (!firstAgent?.working_dir) {
    throw new BadRequestError(
      "Agent must have working_dir configured (no default allowed)",
    );
  }
  return firstAgent.working_dir;
}
