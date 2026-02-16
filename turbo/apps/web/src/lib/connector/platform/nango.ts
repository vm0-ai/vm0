/**
 * Nango Cloud platform adapter for OAuth integration.
 *
 * This adapter uses Nango Cloud to provide OAuth for 100+ providers
 * without maintaining individual OAuth implementations.
 */

import type {
  ConnectorPlatform,
  AuthorizationParams,
  CallbackParams,
  ConnectorResult,
} from "./interface";

/**
 * Map our connector types to Nango integration IDs
 */
const NANGO_INTEGRATION_IDS: Record<string, string> = {
  gmail: "google-mail", // Nango's dev environment uses "google-mail"
};

/**
 * Get Nango integration ID for a connector type
 */
export function getNangoIntegrationId(type: string): string {
  return NANGO_INTEGRATION_IDS[type] ?? type;
}

/**
 * Extract user info from Nango connection
 */
function extractNangoUserInfo(
  connection: { metadata?: unknown; credentials?: unknown },
  fallbackId: string,
): ConnectorResult {
  const credentials = connection.credentials;
  const metadata = connection.metadata;

  const externalId =
    (metadata as { user_id?: string })?.user_id ??
    (metadata as { id?: string })?.id ??
    (credentials as { id?: string })?.id ??
    fallbackId;

  const externalUsername =
    (metadata as { name?: string })?.name ??
    (metadata as { username?: string })?.username ??
    (credentials as { name?: string })?.name ??
    null;

  const externalEmail =
    (metadata as { email?: string })?.email ??
    (credentials as { email?: string })?.email ??
    null;

  const scopes = (credentials as { scope?: string })?.scope?.split(" ") ?? null;

  return {
    externalId,
    externalUsername,
    externalEmail,
    oauthScopes: scopes,
  };
}

async function buildAuthorizationUrl(
  params: AuthorizationParams,
): Promise<string> {
  const nango = globalThis.services.nango;

  const [scopeId] = params.connectionId.split(":");
  if (!scopeId) {
    throw new Error(`Invalid connection ID format: ${params.connectionId}`);
  }

  const session = await nango.createConnectSession({
    end_user: { id: scopeId },
    allowed_integrations: [getNangoIntegrationId(params.type)],
    tags: {
      oauth_state: params.state,
      connection_id: params.connectionId,
    },
  });

  return session.data.connect_link;
}

async function handleCallback(
  params: CallbackParams,
): Promise<ConnectorResult> {
  const nango = globalThis.services.nango;

  try {
    const connection = await nango.getConnection(
      getNangoIntegrationId(params.type),
      params.connectionId,
    );

    return extractNangoUserInfo(connection, params.connectionId);
  } catch (error) {
    throw new Error(
      `Failed to get Nango connection: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

async function getAccessToken(connectorId: string): Promise<string> {
  return connectorId;
}

async function deleteConnection(connectorId: string): Promise<void> {
  const nango = globalThis.services.nango;

  const parts = connectorId.split(":");
  if (parts.length < 2) {
    throw new Error(`Invalid Nango connection ID: ${connectorId}`);
  }

  const providerType = parts[1];
  if (!providerType) {
    throw new Error(`Invalid provider in connection ID: ${connectorId}`);
  }

  try {
    await nango.deleteConnection(
      getNangoIntegrationId(providerType),
      connectorId,
    );
  } catch (error) {
    throw new Error(
      `Failed to delete Nango connection: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

export const NangoPlatform: ConnectorPlatform = {
  name: "nango",
  buildAuthorizationUrl,
  handleCallback,
  getAccessToken,
  deleteConnection,
};
