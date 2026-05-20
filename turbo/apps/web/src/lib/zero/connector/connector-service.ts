import { eq, and } from "drizzle-orm";
import { deriveApiTokenConnectedTypes } from "@vm0/connectors/connector-utils";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { logger } from "../../shared/logger";
import { getSecretValue } from "../secret/secret-service";
import {
  getConnectorOAuthProvider,
  providerEnvFromObject,
} from "@vm0/connectors/oauth-providers";

const log = logger("service:connector");

/**
 * Derive api-token connector types from user secrets and variables.
 * API-token connectors don't have DB records — their existence is inferred
 * from matching user secrets/variables.
 */
export async function getApiTokenConnectorTypes(
  orgId: string,
  userId: string,
): Promise<ConnectorType[]> {
  const db = globalThis.services.db;
  const [userSecretRows, userVariableRows] = await Promise.all([
    db
      .select({ name: secrets.name })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, orgId),
          eq(secrets.userId, userId),
          eq(secrets.type, "user"),
        ),
      ),
    db
      .select({ name: variables.name })
      .from(variables)
      .where(and(eq(variables.orgId, orgId), eq(variables.userId, userId))),
  ]);
  return deriveApiTokenConnectedTypes(
    new Set(
      userSecretRows.map((r) => {
        return r.name;
      }),
    ),
    new Set(
      userVariableRows.map((r) => {
        return r.name;
      }),
    ),
  );
}

/**
 * Best-effort revocation of an OAuth provider's remote token/grant.
 * Looks up the connector's OAuth provider, reads the access token from DB,
 * and calls the provider's revokeToken method if available.
 * Errors are logged and swallowed — revocation must never block disconnect.
 */
export async function revokeConnectorToken(
  orgId: string,
  userId: string,
  type: ConnectorType,
): Promise<void> {
  if (type === "computer") return;

  const provider = getConnectorOAuthProvider(type);
  if (!provider?.revokeToken) return;

  const env = providerEnvFromObject(globalThis.services.env);
  const clientId = provider.getClientId(env);
  const clientSecret = provider.getClientSecret(env);
  if (!clientId || !clientSecret) {
    log.debug(
      `${type} OAuth credentials not configured, skipping token revocation`,
    );
    return;
  }

  const accessTokenName = provider.getSecretName();
  const accessToken = await getSecretValue(
    orgId,
    userId,
    accessTokenName,
    "connector",
  );
  if (!accessToken) {
    log.debug(`${type} access token not found, skipping revocation`);
    return;
  }

  try {
    await provider.revokeToken({ clientId, clientSecret, accessToken });
    log.debug(`${type} token revoked successfully`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.warn(`${type} token revocation failed: ${message}`);
  }
}
