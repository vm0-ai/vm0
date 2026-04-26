import { getConnectorEnvironmentMapping } from "@vm0/connectors/connector-utils";
import {
  connectorTypeSchema,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { and, eq } from "drizzle-orm";
import { logger } from "../../shared/logger";
import { connectors } from "@vm0/db/schema/connector";
import { PROVIDER_HANDLERS } from "../connector/provider-registry";
import { getSecretValues } from "../secret/secret-service";

const log = logger("zero:build-context");

/**
 * Result of connector secret resolution
 */
interface OauthConnectorSecretResult {
  /** OAuth connector secrets resolved from environmentMapping (e.g. { GITHUB_TOKEN: "ghp_..." }) */
  resolvedSecrets: Record<string, string> | undefined;
  /** Maps secret names to connector types for refresh-capable OAuth connectors */
  secretConnectorMap: Record<string, string> | undefined;
  /** Validated OAuth connector types from DB */
  connectorTypes: ConnectorType[];
}

/**
 * Resolve and inject OAuth connector secrets.
 * For each connected OAuth connector, resolves its environmentMapping to produce
 * environment variables (e.g., GH_TOKEN, GITHUB_TOKEN for GitHub connector).
 */
export async function resolveOauthConnectorSecrets(
  orgId: string,
  userId: string,
  allowedTypes?: ConnectorType[],
): Promise<OauthConnectorSecretResult> {
  const db = globalThis.services.db;

  const userConnectors = await db
    .select({ type: connectors.type, authMethod: connectors.authMethod })
    .from(connectors)
    .where(and(eq(connectors.orgId, orgId), eq(connectors.userId, userId)));

  if (userConnectors.length === 0) {
    return {
      resolvedSecrets: undefined,
      secretConnectorMap: undefined,
      connectorTypes: [],
    };
  }

  const connectorSecrets = await getSecretValues(orgId, userId, "connector");
  if (Object.keys(connectorSecrets).length === 0) {
    return {
      resolvedSecrets: undefined,
      secretConnectorMap: undefined,
      connectorTypes: [],
    };
  }

  // Parse connector types upfront (OAuth connectors from DB)
  const validConnectors = userConnectors
    .map((c) => {
      const parsed = connectorTypeSchema.safeParse(c.type);
      return parsed.success
        ? { type: parsed.data, authMethod: c.authMethod }
        : null;
    })
    .filter((c): c is { type: ConnectorType; authMethod: string } => {
      return c !== null;
    });

  // Filter to only allowed connector types when a permission list is provided.
  const allowedConnectors = allowedTypes
    ? validConnectors.filter(({ type }) => {
        return allowedTypes.includes(type);
      })
    : validConnectors;

  // Resolve environment mappings from connectors.
  const allInjectedEnvVars: Record<string, string> = {};

  for (const { type: connectorType } of allowedConnectors) {
    const mapping = getConnectorEnvironmentMapping(connectorType);
    for (const [envVar, valueRef] of Object.entries(mapping)) {
      if (valueRef.startsWith("$secrets.")) {
        const secretName = valueRef.slice("$secrets.".length);
        const secretValue = connectorSecrets[secretName];
        if (secretValue) {
          allInjectedEnvVars[envVar] = secretValue;
        }
      } else {
        allInjectedEnvVars[envVar] = valueRef;
      }
    }
  }

  if (Object.keys(allInjectedEnvVars).length > 0) {
    log.debug(
      `Resolved connector env vars: ${Object.keys(allInjectedEnvVars).join(", ")}`,
    );
  }

  // Build secretConnectorMap for refresh-capable OAuth connectors.
  // Maps secret/env-var name → connector type so the auth endpoint can refresh
  // expired tokens at runtime.  Both the raw secret name (e.g.
  // GOOGLE_CALENDAR_ACCESS_TOKEN) and the mapped env var name (e.g.
  // GOOGLE_CALENDAR_TOKEN) are included because firewall templates may
  // reference either form.
  const secretConnectorMap: Record<string, string> = {};
  for (const { type } of allowedConnectors) {
    if (!(type in PROVIDER_HANDLERS)) continue;
    const handler = PROVIDER_HANDLERS[type as keyof typeof PROVIDER_HANDLERS];
    if (!handler.refreshToken) continue;

    const secretName = handler.getSecretName();
    secretConnectorMap[secretName] = type;

    const mapping = getConnectorEnvironmentMapping(type);
    for (const [envVar, valueRef] of Object.entries(mapping)) {
      if (valueRef === `$secrets.${secretName}`) {
        secretConnectorMap[envVar] = type;
      }
    }
  }

  return {
    resolvedSecrets: allInjectedEnvVars,
    secretConnectorMap:
      Object.keys(secretConnectorMap).length > 0
        ? secretConnectorMap
        : undefined,
    connectorTypes: allowedConnectors.map((c) => {
      return c.type;
    }),
  };
}
