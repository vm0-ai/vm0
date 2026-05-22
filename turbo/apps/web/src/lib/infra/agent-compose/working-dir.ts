import { badRequest } from "@vm0/api-services/errors";
import { isSupportedFramework } from "@vm0/core/frameworks";
import { resolveFrameworkWorkingDir } from "../framework/framework-config";
import type { AgentComposeYaml } from "./types";

export function extractWorkingDir(config: unknown): string {
  const compose = config as AgentComposeYaml | undefined;
  if (!compose?.agents) {
    throw badRequest("Agent compose must have agents configured");
  }

  const agent = Object.values(compose.agents)[0];
  if (!agent) {
    throw badRequest("Agent compose must have at least one agent");
  }

  if (agent.framework && isSupportedFramework(agent.framework)) {
    return resolveFrameworkWorkingDir(agent.framework);
  }

  throw badRequest("Agent must have a supported framework configured");
}
