import type {
  ConnectorType,
  OAuthGrantConnectorType,
} from "@vm0/connectors/connectors";
import { initServices } from "../../lib/init-services";
import { connectors } from "@vm0/db/schema/connector";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { secrets } from "@vm0/db/schema/secret";
import { connectorSessions } from "@vm0/db/schema/connector-session";
import { encryptTestSecretValue } from "../secret-encryption-fixtures";
import { getConnectorOAuthSecretMetadata } from "@vm0/connectors/auth-providers";

// ---------------------------------------------------------------------------
// DB-direct seeders for connector test setup.
//
// Each function has a @why-db-direct annotation explaining why it cannot be
// replaced by an API call or webhook simulation.
// ---------------------------------------------------------------------------

/**
 * Grant a user permission to use a connector for a specific agent.
 * Inserts into the user_connectors table (sparse: presence = enabled).
 *
 * @why-db-direct User-connector grants are normally managed through the
 * connector setup UI which requires a full OAuth flow. Tests need direct
 * control over permission grants without running OAuth.
 */
export async function createTestUserConnector(
  orgId: string,
  userId: string,
  agentId: string,
  connectorType: string,
): Promise<void> {
  initServices();

  await globalThis.services.db
    .insert(userConnectors)
    .values({ orgId, userId, agentId, connectorType })
    .onConflictDoNothing();
}

/**
 * Insert an encrypted connector secret into the database.
 * Used for setting up test state (e.g., access tokens, refresh tokens)
 * without going through the OAuth flow.
 *
 * @why-db-direct Connector secrets are created by the OAuth callback flow.
 * Tests need to pre-populate encrypted tokens without the full OAuth
 * handshake.
 */
export async function insertTestConnectorSecret(
  orgId: string,
  userId: string,
  name: string,
  value: string,
): Promise<void> {
  initServices();
  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  await globalThis.services.db.insert(secrets).values({
    name,
    encryptedValue: encryptTestSecretValue(value, encryptionKey),
    type: "connector",
    userId,
    orgId,
  });
}

/**
 * Create a completed OAuth connector record and access-token secret directly.
 *
 * @why-db-direct The legacy web OAuth callback route has been removed; apps/api
 * owns callback behavior tests. Web route tests need completed connector state
 * as setup data, not another callback exercise.
 */
export async function createTestOAuthConnectorRecord(options: {
  orgId: string;
  userId: string;
  type: OAuthGrantConnectorType;
  accessToken: string;
  externalId: string;
  externalUsername: string;
  externalEmail: string | null;
  oauthScopes: string[];
}): Promise<void> {
  initServices();

  const secretMetadata = getConnectorOAuthSecretMetadata(options.type);
  const tokenExpiresAt = secretMetadata.isRefreshable
    ? new Date(Date.now() + 60 * 60 * 1000)
    : null;
  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const encryptedAccessToken = encryptTestSecretValue(
    options.accessToken,
    encryptionKey,
  );
  await globalThis.services.db
    .insert(secrets)
    .values({
      name: secretMetadata.accessSecretName,
      encryptedValue: encryptedAccessToken,
      type: "connector",
      userId: options.userId,
      orgId: options.orgId,
      description: `OAuth token for ${options.type} connector`,
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      set: {
        encryptedValue: encryptedAccessToken,
        description: `OAuth token for ${options.type} connector`,
        updatedAt: new Date(),
      },
    });

  await globalThis.services.db
    .insert(connectors)
    .values({
      userId: options.userId,
      orgId: options.orgId,
      type: options.type,
      authMethod: "oauth",
      externalId: options.externalId,
      externalUsername: options.externalUsername,
      externalEmail: options.externalEmail,
      oauthScopes: JSON.stringify(options.oauthScopes),
      tokenExpiresAt,
      needsReconnect: false,
    })
    .onConflictDoUpdate({
      target: [connectors.orgId, connectors.userId, connectors.type],
      set: {
        authMethod: "oauth",
        externalId: options.externalId,
        externalUsername: options.externalUsername,
        externalEmail: options.externalEmail,
        oauthScopes: JSON.stringify(options.oauthScopes),
        tokenExpiresAt,
        needsReconnect: false,
        updatedAt: new Date(),
      },
    });
}

/**
 * Generate a unique session code for testing (format: XXXX-XXXX, max 9 chars)
 */
function generateTestSessionCode(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += "-";
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/**
 * Create a test connector session directly in the database.
 * Used for setting up test data for session status tests.
 *
 * @why-db-direct Connector sessions are created by the session
 * initialization endpoint. Tests need precise control over session state,
 * codes, and expiry.
 */
export async function createTestConnectorSession(
  userId: string,
  type: ConnectorType,
  options?: {
    status?: "pending" | "complete" | "error";
    errorMessage?: string;
    expiresAt?: Date;
    completedAt?: Date;
  },
): Promise<typeof connectorSessions.$inferSelect> {
  initServices();
  const expiresAt = options?.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000); // 15 minutes default

  const [session] = await globalThis.services.db
    .insert(connectorSessions)
    .values({
      code: generateTestSessionCode(),
      type,
      userId,
      status: options?.status ?? "pending",
      errorMessage: options?.errorMessage,
      expiresAt,
      completedAt: options?.completedAt,
    })
    .returning();

  return session!;
}
