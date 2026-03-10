import {
  expandVariables,
  extractVariableReferences,
  groupVariablesBySource,
  connectorTypeSchema,
  getConnectorEnvironmentMapping,
  getConnectorProxyConfig,
} from "@vm0/core";
import { env } from "../../../env";
import { createProxyToken } from "../../proxy/token-service";
import { badRequest } from "../../errors";
import { logger } from "../../logger";
import type { AgentComposeYaml } from "../../../types/agent-compose";

const log = logger("run:environment");

/**
 * Result of environment expansion
 */
interface ExpandedEnvironmentResult {
  environment?: Record<string, string>;
}

/**
 * Process secret values: validate, optionally encrypt via proxy tokens.
 */
function processSecretValues(
  secretNames: string[],
  passedSecrets: Record<string, string> | undefined,
  sealSecretsEnabled: boolean,
  checkEnv: boolean | undefined,
  runId: string,
  userId: string,
  connectorEnvVars?: Record<string, string>,
): Record<string, string> | undefined {
  if (secretNames.length === 0) return undefined;

  if (checkEnv) {
    const missingSecrets = secretNames.filter(
      (name) => !passedSecrets || !passedSecrets[name],
    );
    if (missingSecrets.length > 0) {
      throw badRequest(
        `Missing required secrets: ${missingSecrets.join(", ")}. Use '--secrets ${missingSecrets[0]}=<value>' or '--env-file <path>' to provide them.`,
      );
    }
  }

  const secrets: Record<string, string> = {};
  for (const name of secretNames) {
    if (connectorEnvVars?.[name]) {
      secrets[name] = connectorEnvVars[name];
    } else if (sealSecretsEnabled) {
      const secretValue = passedSecrets?.[name];
      if (secretValue) {
        secrets[name] = createProxyToken(runId, userId, name, secretValue);
      }
    } else {
      secrets[name] = passedSecrets![name]!;
    }
  }
  return Object.keys(secrets).length > 0 ? secrets : undefined;
}

/**
 * Process credential values: validate, optionally encrypt via proxy tokens.
 */
function processCredentialValues(
  credentialNames: string[],
  credentials: Record<string, string> | undefined,
  sealSecretsEnabled: boolean,
  checkEnv: boolean | undefined,
  runId: string,
  userId: string,
  connectorEnvVars?: Record<string, string>,
): Record<string, string> | undefined {
  if (credentialNames.length === 0) return undefined;

  if (checkEnv) {
    const missingCredentials = credentialNames.filter(
      (name) => !credentials || !credentials[name],
    );
    if (missingCredentials.length > 0) {
      const platformUrl = env().NEXT_PUBLIC_PLATFORM_URL;
      const settingsUrl = `${platformUrl}/settings?tab=secrets-and-variables`;
      throw badRequest(
        `Missing required secrets: ${missingCredentials.join(", ")}. Use 'vm0 secret set ${missingCredentials[0]} <value>' or add them at: ${settingsUrl}`,
      );
    }
  }

  const processed: Record<string, string> = {};
  for (const name of credentialNames) {
    if (connectorEnvVars?.[name]) {
      processed[name] = connectorEnvVars[name];
    } else if (sealSecretsEnabled) {
      const credentialValue = credentials?.[name];
      if (credentialValue) {
        processed[name] = createProxyToken(
          runId,
          userId,
          name,
          credentialValue,
        );
      }
    } else {
      processed[name] = credentials![name]!;
    }
  }
  return Object.keys(processed).length > 0 ? processed : undefined;
}

/**
 * Build connector env var placeholders for experimental_connectors that are actually connected.
 * Returns a map of env var name → placeholder value, or undefined if no connectors qualify.
 */
function buildConnectorEnvVars(
  declaredConnectors: string[],
  connectedTypes: string[],
): Record<string, string> | undefined {
  if (declaredConnectors.length === 0 || connectedTypes.length === 0)
    return undefined;

  const connected = new Set(connectedTypes);
  const envVars: Record<string, string> = {};

  for (const name of declaredConnectors) {
    if (!connected.has(name)) continue;
    const parsed = connectorTypeSchema.safeParse(name);
    if (!parsed.success) continue;
    const connectorType = parsed.data;
    const proxyConfig = getConnectorProxyConfig(connectorType);
    if (!proxyConfig) continue;

    const envMapping = getConnectorEnvironmentMapping(connectorType);
    for (const envVar of Object.keys(envMapping)) {
      envVars[envVar] =
        proxyConfig.placeholders?.[envVar] ?? `VM0_PLACEHOLDER_${envVar}`;
    }
  }
  return Object.keys(envVars).length > 0 ? envVars : undefined;
}

/**
 * Extract and expand environment variables from agent compose config
 * Expands ${{ vars.xxx }}, ${{ secrets.xxx }}, and ${{ credentials.xxx }} references
 *
 * When experimental_firewall.experimental_seal_secrets is enabled:
 * - Secrets are encrypted into proxy tokens (vm0_enc_xxx)
 *
 * When experimental_connectors is declared:
 * - Connector env vars are set to placeholder values (proxy replaces at runtime)
 *
 * @param agentCompose Agent compose configuration
 * @param vars Variables for expansion (from --vars CLI param)
 * @param passedSecrets Secrets for expansion (from --secrets CLI param, already decrypted)
 * @param credentials Credentials for expansion (from platform credential store)
 * @param userId User ID for token binding
 * @param runId Run ID for token binding (required for seal_secrets)
 * @param checkEnv When true, validates that all required secrets/vars are provided
 * @returns Expanded environment variables
 */
// eslint-disable-next-line complexity
export function expandEnvironmentFromCompose(
  agentCompose: unknown,
  vars: Record<string, string> | undefined,
  passedSecrets: Record<string, string> | undefined,
  credentials: Record<string, string> | undefined,
  userId: string,
  runId: string,
  checkEnv?: boolean,
  /** Connected connector type names — only these get placeholder injection. */
  connectedTypes?: string[],
): ExpandedEnvironmentResult {
  const compose = agentCompose as AgentComposeYaml | undefined;
  if (!compose?.agents) {
    return { environment: undefined };
  }

  // Get first agent's environment (currently only one agent supported)
  const agents = Object.values(compose.agents);
  const firstAgent = agents[0];

  if (!firstAgent?.environment) {
    return { environment: undefined };
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

  // Check if seal_secrets is enabled via firewall config
  const sealSecretsEnabled =
    firstAgent?.experimental_firewall?.experimental_seal_secrets ?? false;

  // Build connector env var placeholders from experimental_connectors ∩ connectedTypes
  const connectorEnvVars = buildConnectorEnvVars(
    firstAgent?.experimental_connectors ?? [],
    connectedTypes ?? [],
  );

  // Process secrets if needed
  const secretNames = grouped.secrets.map((r) => r.name);
  const secrets = processSecretValues(
    secretNames,
    passedSecrets,
    sealSecretsEnabled,
    checkEnv,
    runId,
    userId,
    connectorEnvVars,
  );

  // Process credentials if needed
  const credentialNames = grouped.credentials.map((r) => r.name);
  const processedCredentials = processCredentialValues(
    credentialNames,
    credentials,
    sealSecretsEnabled,
    checkEnv,
    runId,
    userId,
    connectorEnvVars,
  );

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

  // Check for missing vars (only when checkEnv is enabled)
  if (checkEnv) {
    const missingVarNames = missingVars
      .filter((v) => v.source === "vars")
      .map((v) => v.name);
    if (missingVarNames.length > 0) {
      throw badRequest(
        `Missing required variables: ${missingVarNames.join(", ")}. Use '--vars ${missingVarNames[0]}=<value>' or '--env-file <path>' to provide them.`,
      );
    }
  }

  return { environment: result };
}
