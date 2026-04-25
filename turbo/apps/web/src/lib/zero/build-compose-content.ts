import { connectorTypeSchema } from "@vm0/api-contracts/contracts/connectors";
import {
  getConnectorEnvironmentMapping,
  getEligibleConnectorTypes,
} from "@vm0/api-contracts/contracts/connector-utils";
import { getInstructionsFilename } from "@vm0/core/frameworks";

/**
 * Build compose content for a zero agent.
 *
 * Produces a compose object with framework, instructions, and environment.
 * Connector env var templates are baked into the compose so that
 * expandEnvironmentFromCompose can resolve firewall placeholders at runtime.
 *
 * Skills are NOT included in compose — they are injected at runtime via
 * buildSystemSkillVolumes() → AdditionalVolumes.
 */
export function buildComposeContent(
  agentName: string,
): Record<string, unknown> {
  const eligibleConnectorTypes = getEligibleConnectorTypes();

  const environment: Record<string, string> = {
    ZERO_AGENT_ID: "${{ vars.ZERO_AGENT_ID }}",
    ZERO_TOKEN: "${{ secrets.ZERO_TOKEN }}",
  };

  // Inject env var templates from connector environmentMappings so that
  // expandEnvironmentFromCompose can substitute firewall placeholders.
  for (const connector of eligibleConnectorTypes) {
    const parsed = connectorTypeSchema.safeParse(connector);
    if (!parsed.success) continue;
    const mapping = getConnectorEnvironmentMapping(parsed.data);
    for (const [envVar, valueRef] of Object.entries(mapping)) {
      if (envVar in environment) continue;
      if (valueRef.startsWith("$secrets.")) {
        environment[envVar] = `\${{ secrets.${envVar} }}`;
      } else if (valueRef.startsWith("$vars.")) {
        environment[envVar] = `\${{ vars.${envVar} }}`;
      }
    }
  }

  const agentDef: Record<string, unknown> = {
    framework: "claude-code",
    instructions: getInstructionsFilename("claude-code"),
    environment,
  };

  return {
    version: "1",
    agents: {
      [agentName]: agentDef,
    },
  };
}
