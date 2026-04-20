import { and, eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { secrets } from "../../db/schema/secret";
import { connectors } from "../../db/schema/connector";
import { userConnectors } from "../../db/schema/user-connector";
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
  type: "connector" | "user" = "connector",
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
