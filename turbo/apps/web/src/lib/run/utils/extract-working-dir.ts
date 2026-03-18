import { isSupportedFramework } from "@vm0/core";
import { resolveFrameworkWorkingDir } from "../../framework/framework-config";
import { badRequest } from "../../errors";
import { logger } from "../../logger";
import type { AgentComposeYaml } from "../../../types/agent-compose";

const log = logger("extract-working-dir");

/**
 * Extract working directory from agent config.
 * Resolves from framework at runtime via framework-config.
 * Falls back to legacy working_dir field for old stored composes.
 *
 * @param config Agent compose configuration
 * @returns Working directory path
 * @throws BadRequestError if framework is unsupported and no legacy fallback
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

  // Resolve from framework (primary path)
  if (agent.framework && isSupportedFramework(agent.framework)) {
    return resolveFrameworkWorkingDir(agent.framework);
  }

  // Fallback for legacy stored composes that still have working_dir
  // TODO: Remove after data migration of old composes to use framework field
  const legacy = (agent as unknown as Record<string, unknown>).working_dir;
  if (typeof legacy === "string") {
    log.warn(
      "Using deprecated working_dir field from stored compose. Migrate compose to use framework field instead.",
    );
    return legacy;
  }

  throw badRequest("Agent must have a supported framework configured");
}
