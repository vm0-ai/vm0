import { isSupportedFramework } from "@vm0/core/frameworks";
import { resolveFrameworkWorkingDir } from "../../framework/framework-config";
import { badRequest } from "@vm0/api-services/errors";
import type { AgentComposeYaml } from "../../agent-compose/types";

/**
 * Extract working directory from agent config.
 * Resolves from framework at runtime via framework-config.
 *
 * @param config Agent compose configuration
 * @returns Working directory path
 * @throws BadRequestError if framework is unsupported
 */
export function extractWorkingDir(config: unknown): string {
  const compose = config as AgentComposeYaml | undefined;
  if (!compose?.agents) {
    throw badRequest("Agent compose must have agents configured");
  }
  const agents = Object.values(compose.agents);
  const agent = agents[0];
  if (!agent) {
    throw badRequest("Agent compose must have at least one agent");
  }

  if (agent.framework && isSupportedFramework(agent.framework)) {
    return resolveFrameworkWorkingDir(agent.framework);
  }

  throw badRequest("Agent must have a supported framework configured");
}
