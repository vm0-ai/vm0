import type { ConnectorType } from "@vm0/core";
import { initServices } from "../../lib/init-services";
import { userConnectors } from "../../db/schema/user-connector";
import { userPlatformConnectors } from "../../db/schema/user-platform-connector";
import { secrets } from "../../db/schema/secret";
import { connectorSessions } from "../../db/schema/connector-session";
import { encryptSecretValue } from "../../lib/shared/crypto/secrets-encryption";

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
    encryptedValue: encryptSecretValue(value, encryptionKey),
    type: "connector",
    userId,
    orgId,
  });
}

/**
 * Enable a platform-supplied connector for a test user by inserting a row
 * directly into `user_platform_connectors`.
 *
 * @why-db-direct Tests that verify cascade deletion need to seed the
 * enablement row without exercising the POST route (which carries its own
 * auth + feature-flag requirements orthogonal to what's being verified).
 */
export async function insertTestPlatformConnector(
  orgId: string,
  userId: string,
  type: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .insert(userPlatformConnectors)
    .values({ orgId, userId, type })
    .onConflictDoNothing();
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
