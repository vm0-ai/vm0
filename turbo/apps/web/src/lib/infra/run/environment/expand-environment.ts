import {
  extractSecretNamesFromApis,
  type ExpandedFirewallConfig,
} from "@vm0/api-contracts/contracts/firewalls";
import {
  expandVariables,
  extractAndGroupVariables,
} from "@vm0/core/variable-expander";
import { logger } from "../../../shared/logger";
import type { AgentComposeYaml } from "../../agent-compose/types";

const log = logger("run:environment");

/**
 * Result of environment expansion
 */
interface ExpandedEnvironmentResult {
  environment?: Record<string, string>;
}

/**
 * Process secret values: resolve from passed secrets or firewall placeholders.
 */
function processSecretValues(
  secretNames: string[],
  passedSecrets: Record<string, string> | undefined,
  firewallPlaceholders?: Record<string, string>,
): Record<string, string> | undefined {
  if (secretNames.length === 0) return undefined;

  const secrets: Record<string, string> = {};
  for (const name of secretNames) {
    if (firewallPlaceholders?.[name]) {
      secrets[name] = firewallPlaceholders[name];
    } else {
      secrets[name] = passedSecrets![name]!;
    }
  }
  return Object.keys(secrets).length > 0 ? secrets : undefined;
}

/**
 * Build firewall placeholder map keyed by canonical secret name.
 * Reads pre-expanded firewall configs and extracts secret names from auth templates
 * (`${{ secrets.XXX }}`), then maps each to a placeholder value (custom or auto-generated).
 */
function buildFirewallPlaceholders(
  expandedFirewallConfigs: ExpandedFirewallConfig[],
): Record<string, string> | undefined {
  if (expandedFirewallConfigs.length === 0) return undefined;

  const placeholders: Record<string, string> = {};

  for (const fw of expandedFirewallConfigs) {
    const secretNames = extractSecretNamesFromApis(fw.apis);
    for (const secretName of secretNames) {
      placeholders[secretName] =
        fw.placeholders?.[secretName] ??
        "c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe";
    }
    // Connector firewalls carry expanded placeholders that cover raw OAuth
    // secret names and aliased env vars beyond what auth templates reference.
    if (fw.placeholders) {
      for (const [key, value] of Object.entries(fw.placeholders)) {
        if (!placeholders[key]) {
          placeholders[key] = value;
        }
      }
    }
  }
  return Object.keys(placeholders).length > 0 ? placeholders : undefined;
}

/**
 * Extract and expand environment variables from agent compose config.
 * Expands ${{ vars.xxx }} and ${{ secrets.xxx }} references.
 *
 * Firewall secret values are replaced with placeholders (proxy resolves real secrets at runtime).
 * All firewalls (compose-declared, model provider, connector) are passed via the `firewalls` param.
 *
 * @param agentCompose Agent compose configuration
 * @param vars Variables for expansion (from --vars CLI param)
 * @param passedSecrets Secrets for expansion (from --secrets CLI param, already decrypted)
 * @param additionalEnvironment Extra env entries (e.g. model provider) to merge before expansion.
 *   Compose-declared entries take precedence. Secret-derived values should use
 *   $\{{ secrets.X }} templates so firewallPlaceholders logic applies.
 * @param firewalls All expanded firewall configs for placeholder injection.
 * @returns Expanded environment variables
 */
export function expandEnvironmentFromCompose(
  agentCompose: unknown,
  vars: Record<string, string> | undefined,
  passedSecrets: Record<string, string> | undefined,
  additionalEnvironment?: Record<string, string>,
  firewalls?: ExpandedFirewallConfig[],
): ExpandedEnvironmentResult {
  const compose = agentCompose as AgentComposeYaml | undefined;

  // Get first agent config
  const firstAgent = compose?.agents
    ? Object.values(compose.agents)[0]
    : undefined;

  // Merge environments: compose entries take precedence over additional entries
  const environment: Record<string, string> = {
    ...additionalEnvironment,
    ...firstAgent?.environment,
  };

  if (Object.keys(environment).length === 0) {
    return { environment: undefined };
  }

  // Extract all variable references to determine what we need
  const grouped = extractAndGroupVariables(environment);

  // Check for unsupported env references
  if (grouped.env.length > 0) {
    log.warn(
      "Environment contains $" +
        "{{ env.xxx }} references which are not supported: " +
        grouped.env
          .map((r) => {
            return r.name;
          })
          .join(", "),
    );
  }

  const firewallPlaceholders = buildFirewallPlaceholders(firewalls ?? []);

  // Process secrets if needed
  const secretNames = grouped.secrets.map((r) => {
    return r.name;
  });
  const secrets = processSecretValues(
    secretNames,
    passedSecrets,
    firewallPlaceholders,
  );

  // Build sources for expansion
  const sources: {
    vars?: Record<string, string>;
    secrets?: Record<string, string>;
  } = {};
  if (vars && Object.keys(vars).length > 0) {
    sources.vars = vars;
  }
  if (secrets && Object.keys(secrets).length > 0) {
    sources.secrets = secrets;
  }

  // If no sources provided and there are vars references, warn
  if (!sources.vars && grouped.vars.length > 0) {
    log.warn(
      "Environment contains $" +
        "{{ vars.xxx }} but no vars provided: " +
        grouped.vars
          .map((r) => {
            return r.name;
          })
          .join(", "),
    );
  }

  // Expand all variables
  const { result } = expandVariables(environment, sources);

  return { environment: result };
}
