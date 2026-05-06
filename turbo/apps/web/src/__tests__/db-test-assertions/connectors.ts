import { and, eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { secrets } from "@vm0/db/schema/secret";
import { connectors } from "@vm0/db/schema/connector";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { userPlatformConnectors } from "@vm0/db/schema/user-platform-connector";
import { decryptSecretValue } from "../../lib/shared/crypto/secrets-encryption";

// ---------------------------------------------------------------------------
// Read-only assertion helpers for connector test verification.
// ---------------------------------------------------------------------------

/**
 * Find and decrypt a connector secret token from the database.
 * Used for verifying that the correct token was stored during connector
 * OAuth flow.
 */
export async function findTestConnectorSecret(
  orgId: string,
  secretName: string,
  type: "connector" | "user" | "model-provider" = "connector",
): Promise<string | undefined> {
  initServices();
  const [storedSecret] = await globalThis.services.db
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, orgId),
        eq(secrets.name, secretName),
        eq(secrets.type, type),
      ),
    )
    .limit(1);

  if (!storedSecret) return undefined;

  return decryptSecretValue(
    storedSecret.encryptedValue,
    globalThis.services.env.SECRETS_ENCRYPTION_KEY,
  );
}

/**
 * Get the tokenExpiresAt timestamp for a connector.
 * Used for verifying that token expiry was correctly stored during OAuth
 * flow.
 */
export async function findTestConnectorTokenExpiresAt(
  orgId: string,
  type: string,
): Promise<Date | null | undefined> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ tokenExpiresAt: connectors.tokenExpiresAt })
    .from(connectors)
    .where(and(eq(connectors.orgId, orgId), eq(connectors.type, type)))
    .limit(1);

  if (!row) return undefined;
  return row.tokenExpiresAt;
}

/**
 * List the connector types granted to a (user, agent) pair. Returns the
 * literal `connector_type` strings in insertion order.
 */
export async function findUserConnectorTypes(
  userId: string,
  agentId: string,
): Promise<string[]> {
  initServices();
  const rows = await globalThis.services.db
    .select({ connectorType: userConnectors.connectorType })
    .from(userConnectors)
    .where(
      and(
        eq(userConnectors.userId, userId),
        eq(userConnectors.agentId, agentId),
      ),
    );
  return rows.map((r) => {
    return r.connectorType;
  });
}

/**
 * Count rows in `user_platform_connectors` for a given (orgId, userId, type)
 * tuple. Used by route tests to pin "POST is idempotent at the row level",
 * not just via response status.
 */
export async function countPlatformConnectorRows(
  orgId: string,
  userId: string,
  type: string,
): Promise<number> {
  initServices();
  const rows = await globalThis.services.db
    .select({ id: userPlatformConnectors.id })
    .from(userPlatformConnectors)
    .where(
      and(
        eq(userPlatformConnectors.orgId, orgId),
        eq(userPlatformConnectors.userId, userId),
        eq(userPlatformConnectors.type, type),
      ),
    );
  return rows.length;
}
