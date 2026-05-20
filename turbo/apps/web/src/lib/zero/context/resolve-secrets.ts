import { getConnectorProvidedSecretNames } from "@vm0/connectors/connector-utils";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { extractAndGroupVariables } from "@vm0/core/variable-expander";
import { logger } from "../../shared/logger";
import { getSecretValues } from "../secret/secret-service";
import { getVariableValues } from "../variable/variable-service";
import { ORG_SENTINEL_USER_ID } from "../org/org-sentinel";
import { env } from "../../../env";

const log = logger("zero:build-context");

/**
 * Fetch secrets referenced in compose environment
 */
export async function fetchReferencedSecrets(
  orgId: string,
  userId: string,
  environment: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  if (!environment) {
    return undefined;
  }

  const grouped = extractAndGroupVariables(environment);

  if (grouped.secrets.length === 0) {
    return undefined;
  }

  const referencedNames = grouped.secrets.map((r) => {
    return r.name;
  });
  log.debug(`Secrets referenced in environment: ${referencedNames.join(", ")}`);

  // Fetch org and user secrets in parallel, merge with user > org priority
  const [orgSecrets, userSecrets] = await Promise.all([
    getSecretValues(orgId, ORG_SENTINEL_USER_ID, "user"),
    getSecretValues(orgId, userId, "user"),
  ]);
  const mergedSecrets = { ...orgSecrets, ...userSecrets };
  log.debug(
    `Fetched ${Object.keys(mergedSecrets).length} user secret(s) for org ${orgId}`,
  );
  return mergedSecrets;
}

/**
 * Filter dbSecrets to remove env vars that belong to connectors not in allowedConnectorTypes.
 * Custom user secrets (not owned by any connector) pass through unfiltered.
 * When allowedConnectorTypes is undefined (e.g. CLI runs), no filtering is applied.
 */
export function filterDbSecretsByConnectorPermissions(
  dbSecrets: Record<string, string> | undefined,
  allApiTokenTypes: ConnectorType[],
  allowedConnectorTypes: ConnectorType[] | undefined,
): Record<string, string> | undefined {
  if (!dbSecrets || !allowedConnectorTypes) {
    return dbSecrets;
  }

  // Compute the set of env var names belonging to ALL api-token connectors the user has.
  const allConnectorEnvVars = getConnectorProvidedSecretNames(allApiTokenTypes);
  // Compute the set of env var names belonging to ALLOWED connectors only.
  const allowedApiTokenTypes = allApiTokenTypes.filter((t) => {
    return allowedConnectorTypes.includes(t);
  });
  const allowedEnvVars = getConnectorProvidedSecretNames(allowedApiTokenTypes);
  // Disallowed = belongs to a connector but not an allowed one.
  const disallowed = new Set(
    [...allConnectorEnvVars].filter((name) => {
      return !allowedEnvVars.has(name);
    }),
  );

  if (disallowed.size === 0) {
    return dbSecrets;
  }

  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(dbSecrets)) {
    if (!disallowed.has(key)) {
      filtered[key] = value;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

/**
 * Env vars that should be injected into the context secrets map at runtime.
 * These platform-level credentials are set via 1Password → process.env
 * and are NOT stored in the DB variables/secrets tables.
 *
 * Each entry is read from process.env at context build time and injected into
 * the secrets map, making it available for ${{ secrets.XXX }} template
 * resolution in firewall auth headers.
 */
const ENV_SECRET_NAMES = ["GOOGLE_ADS_DEVELOPER_TOKEN"] as const;

/**
 * Read whitelisted env vars into the secrets map.
 * Values not set in the environment are silently skipped.
 */
export function injectPlatformEnvSecrets(
  connectorTypes: readonly ConnectorType[],
): Record<string, string> | undefined {
  if (!connectorTypes.includes("google-ads")) {
    return undefined;
  }

  const result: Record<string, string> = {};
  const platformEnv = env();
  for (const name of ENV_SECRET_NAMES) {
    const value = platformEnv[name];
    if (value) {
      result[name] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Fetch server-stored variables and merge with CLI-provided vars
 * Priority: CLI vars > server-stored vars
 *
 * @param userId Clerk user ID
 * @param cliVars Variables from CLI --vars flag
 * @returns Merged variables (CLI takes precedence)
 */
export async function fetchAndMergeVariables(
  orgId: string,
  userId: string,
  cliVars: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  // Fetch org and user variables in parallel, merge with user > org priority
  const [orgVars, userVars] = await Promise.all([
    getVariableValues(orgId, ORG_SENTINEL_USER_ID),
    getVariableValues(orgId, userId),
  ]);
  const storedVars = { ...orgVars, ...userVars };
  if (Object.keys(storedVars).length === 0) {
    return cliVars;
  }

  log.debug(
    `Fetched ${Object.keys(storedVars).length} stored variable(s) for org ${orgId}`,
  );

  // Merge: CLI vars override stored vars
  const merged = { ...storedVars, ...cliVars };
  return Object.keys(merged).length > 0 ? merged : undefined;
}
