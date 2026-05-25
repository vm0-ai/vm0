import type {
  ConnectorType,
  OAuthConnectorType,
} from "@vm0/connectors/connectors";
import { getConnectorOAuthScopes } from "@vm0/connectors/connector-utils";
import { createTestOAuthConnectorRecord } from "../db-test-seeders/connectors";
import { createTestSecret } from "./secrets";
import { getTestAuthContext } from "./core";

// ---------------------------------------------------------------------------
// Re-exports: DB-direct seeders and assertion helpers.
//
// These functions were moved to dedicated directories but are re-exported
// here for backward compatibility — existing test files import from
// api-test-helpers and should continue to work unchanged.
// ---------------------------------------------------------------------------

export {
  createTestUserConnector,
  insertTestConnectorSecret,
  createTestConnectorSession,
} from "../db-test-seeders/connectors";

export {
  findTestConnectorSecret,
  findTestConnectorTokenExpiresAt,
} from "../db-test-assertions/connectors";

// ---------------------------------------------------------------------------
// Connector helpers.
// ---------------------------------------------------------------------------

/**
 * Create an api-token connector by storing user secrets via PUT /api/secrets.
 * Api-token connector status is now derived from user secrets, not DB records.
 */
async function createTestApiTokenConnector(options?: {
  type?: ConnectorType;
  accessToken?: string;
  secretName?: string;
}): Promise<void> {
  const type = options?.type ?? "github";
  const tokenValue = options?.accessToken ?? "test-api-token";
  const secretName =
    options?.secretName ?? `${type.toUpperCase().replace(/-/g, "_")}_TOKEN`;

  await createTestSecret(
    secretName,
    tokenValue,
    `API token for ${type} connector`,
  );
}

/**
 * Create an OAuth connector record with the same storage path used after the
 * callback flow completes.
 */
async function createTestOAuthConnector(options?: {
  type?: OAuthConnectorType;
  accessToken?: string;
  externalUsername?: string;
  externalId?: string | null;
  externalEmail?: string | null;
  oauthScopes?: string[];
}): Promise<void> {
  const type = options?.type ?? "github";
  const { orgId, userId } = await getTestAuthContext();
  await createTestOAuthConnectorRecord({
    orgId,
    userId,
    type,
    accessToken: options?.accessToken ?? `test-${type}-token`,
    externalId: options?.externalId ?? `test-${type}-external-id`,
    externalUsername: options?.externalUsername ?? "testuser",
    externalEmail: options?.externalEmail ?? "test@example.com",
    oauthScopes: options?.oauthScopes ?? getConnectorOAuthScopes(type),
  });
}

/**
 * Create a test connector via API routes.
 *
 * - api-token: calls POST /api/connectors/:type/token
 * - oauth: stores the completed connector state used after callback success
 *
 * @param options - Connector configuration
 */
type CreateTestConnectorOptions =
  | {
      type?: OAuthConnectorType;
      authMethod?: "oauth";
      accessToken?: string;
      externalUsername?: string;
      externalId?: string | null;
      externalEmail?: string | null;
      oauthScopes?: string[];
      userId?: string;
    }
  | {
      type?: ConnectorType;
      authMethod: "api-token";
      accessToken?: string;
      /** Secret name for api-token (e.g. "FIGMA_TOKEN"). Required for api-token. */
      secretName?: string;
      externalUsername?: string;
      externalId?: string | null;
      externalEmail?: string | null;
      oauthScopes?: string[];
      userId?: string;
    };

export async function createTestConnector(
  options?: CreateTestConnectorOptions,
): Promise<void> {
  if (options?.authMethod === "api-token") {
    await createTestApiTokenConnector(options);
  } else {
    await createTestOAuthConnector(options);
  }
}
