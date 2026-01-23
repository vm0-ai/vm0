import {
  expandVariables,
  extractVariableReferences,
  groupVariablesBySource,
} from "@vm0/core";
import { createProxyToken } from "../../proxy/token-service";
import { BadRequestError } from "../../errors";
import { logger } from "../../logger";
import type { AgentComposeYaml } from "../../../types/agent-compose";

const log = logger("run:environment");

/**
 * Result of environment expansion
 */
interface ExpandedEnvironmentResult {
  environment?: Record<string, string>;
  sealSecretsEnabled: boolean;
}

/**
 * Extract and expand environment variables from agent compose config
 * Expands ${{ vars.xxx }}, ${{ secrets.xxx }}, and ${{ credentials.xxx }} references
 *
 * When experimental_firewall.experimental_seal_secrets is enabled:
 * - Secrets are encrypted into proxy tokens (vm0_enc_xxx)
 *
 * @param agentCompose Agent compose configuration
 * @param vars Variables for expansion (from --vars CLI param)
 * @param passedSecrets Secrets for expansion (from --secrets CLI param, already decrypted)
 * @param credentials Credentials for expansion (from platform credential store)
 * @param userId User ID for token binding
 * @param runId Run ID for token binding (required for seal_secrets)
 * @returns Expanded environment variables and seal_secrets flag
 */
// eslint-disable-next-line complexity -- TODO: refactor complex function
export function expandEnvironmentFromCompose(
  agentCompose: unknown,
  vars: Record<string, string> | undefined,
  passedSecrets: Record<string, string> | undefined,
  credentials: Record<string, string> | undefined,
  userId: string,
  runId: string,
): ExpandedEnvironmentResult {
  const compose = agentCompose as AgentComposeYaml | undefined;
  if (!compose?.agents) {
    return { environment: undefined, sealSecretsEnabled: false };
  }

  // Get first agent's environment (currently only one agent supported)
  const agents = Object.values(compose.agents);
  const firstAgent = agents[0];

  // Check if seal_secrets is enabled via firewall config
  const sealSecretsEnabled =
    firstAgent?.experimental_firewall?.experimental_seal_secrets ?? false;

  if (!firstAgent?.environment) {
    return {
      environment: undefined,
      sealSecretsEnabled,
    };
  }

  const environment = firstAgent.environment;

  // Extract all variable references to determine what we need
  const refs = extractVariableReferences(environment);
  const grouped = groupVariablesBySource(refs);

  // Check for unsupported env references
  if (grouped.env.length > 0) {
    log.warn(
      "Environment contains $" +
        "{{ env.xxx }} references which are not supported: " +
        grouped.env.map((r) => r.name).join(", "),
    );
  }

  // Process secrets if needed
  let secrets: Record<string, string> | undefined;
  if (grouped.secrets.length > 0) {
    const secretNames = grouped.secrets.map((r) => r.name);

    // Check for missing secrets
    const missingSecrets = secretNames.filter(
      (name) => !passedSecrets || !passedSecrets[name],
    );
    if (missingSecrets.length > 0) {
      throw new BadRequestError(
        `Missing required secrets: ${missingSecrets.join(", ")}. Use '--secrets ${missingSecrets[0]}=<value>' to provide them.`,
      );
    }

    // If seal_secrets is enabled, encrypt secrets into proxy tokens
    if (sealSecretsEnabled) {
      log.debug(
        `Seal secrets enabled for run ${runId}, encrypting ${secretNames.length} secret(s)`,
      );
      secrets = {};
      for (const name of secretNames) {
        const secretValue = passedSecrets![name];
        if (secretValue) {
          // Create encrypted proxy token bound to this run
          secrets[name] = createProxyToken(runId, userId, name, secretValue);
        }
      }
    } else {
      // Default: use plaintext secrets
      secrets = {};
      for (const name of secretNames) {
        secrets[name] = passedSecrets![name]!;
      }
    }
  }

  // Process credentials if needed
  let processedCredentials: Record<string, string> | undefined;
  if (grouped.credentials.length > 0) {
    const credentialNames = grouped.credentials.map((r) => r.name);

    // Check for missing credentials
    const missingCredentials = credentialNames.filter(
      (name) => !credentials || !credentials[name],
    );
    if (missingCredentials.length > 0) {
      throw new BadRequestError(
        `Missing required credentials: ${missingCredentials.join(", ")}. Use 'vm0 credential set ${missingCredentials[0]} <value>' to add them.`,
      );
    }

    // If seal_secrets is enabled, encrypt credentials into proxy tokens
    if (sealSecretsEnabled) {
      log.debug(
        `Seal secrets enabled for run ${runId}, encrypting ${credentialNames.length} credential(s)`,
      );
      processedCredentials = {};
      for (const name of credentialNames) {
        const credentialValue = credentials![name];
        if (credentialValue) {
          // Create encrypted proxy token bound to this run
          processedCredentials[name] = createProxyToken(
            runId,
            userId,
            name,
            credentialValue,
          );
        }
      }
    } else {
      // Default: use plaintext credentials
      processedCredentials = {};
      for (const name of credentialNames) {
        processedCredentials[name] = credentials![name]!;
      }
    }
  }

  // Build sources for expansion
  const sources: {
    vars?: Record<string, string>;
    secrets?: Record<string, string>;
    credentials?: Record<string, string>;
  } = {};
  if (vars && Object.keys(vars).length > 0) {
    sources.vars = vars;
  }
  if (secrets && Object.keys(secrets).length > 0) {
    sources.secrets = secrets;
  }
  if (processedCredentials && Object.keys(processedCredentials).length > 0) {
    sources.credentials = processedCredentials;
  }

  // If no sources provided and there are vars references, warn
  if (!sources.vars && grouped.vars.length > 0) {
    log.warn(
      "Environment contains $" +
        "{{ vars.xxx }} but no vars provided: " +
        grouped.vars.map((r) => r.name).join(", "),
    );
  }

  // Expand all variables
  const { result, missingVars } = expandVariables(environment, sources);

  // Check for missing vars (secrets and credentials already checked above)
  const missingVarNames = missingVars
    .filter((v) => v.source === "vars")
    .map((v) => v.name);
  if (missingVarNames.length > 0) {
    throw new BadRequestError(
      `Missing required variables for environment: ${missingVarNames.join(", ")}`,
    );
  }

  return { environment: result, sealSecretsEnabled };
}
