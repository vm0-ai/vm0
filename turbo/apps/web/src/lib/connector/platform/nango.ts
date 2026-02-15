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

export class NangoPlatform implements ConnectorPlatform {
  readonly name = "nango" as const;

  async buildAuthorizationUrl(params: AuthorizationParams): Promise<string> {
    // For Nango providers, we create a connect session and return the connect_link
    // Reference: https://docs.nango.dev/reference/sdks/node
    const nango = globalThis.services.nango;

    // Parse connectionId to get user scope ID
    // Format: "scopeId:providerType"
    const [scopeId] = params.connectionId.split(":");
    if (!scopeId) {
      throw new Error(`Invalid connection ID format: ${params.connectionId}`);
    }

    // Create connect session
    const session = await nango.createConnectSession({
      end_user: {
        id: scopeId,
        // We can add more user info here if available
      },
      allowed_integrations: [params.type],
      // Store state in tags for verification on callback
      tags: {
        oauth_state: params.state,
        connection_id: params.connectionId,
      },
    });

    // Return the Nango-hosted connect link
    return session.data.connect_link;
  }

  async handleCallback(params: CallbackParams): Promise<ConnectorResult> {
    const nango = globalThis.services.nango;

    // Nango automatically handles the OAuth callback and exchanges the code
    // We just need to verify the connection was created successfully
    try {
      // Get the connection to verify it exists and retrieve metadata
      // Note: providerConfigKey is the integration ID (e.g., "gmail")
      const connection = await nango.getConnection(
        params.type, // integration ID
        params.connectionId, // connection ID
      );

      // Extract user info from connection
      // Nango stores provider-specific user info in the connection object
      const credentials = connection.credentials;
      const metadata = connection.metadata;

      // Try to extract user info from metadata or credentials
      const externalId =
        (metadata?.user_id as string) ??
        (metadata?.id as string) ??
        (credentials as { id?: string })?.id ??
        params.connectionId;

      const externalUsername =
        (metadata?.name as string) ??
        (metadata?.username as string) ??
        (credentials as { name?: string })?.name ??
        null;

      const externalEmail =
        (metadata?.email as string) ??
        (credentials as { email?: string })?.email ??
        null;

      // Extract scopes from credentials if available
      const scopes =
        (credentials as { scope?: string })?.scope?.split(" ") ?? null;

      return {
        externalId,
        externalUsername,
        externalEmail,
        oauthScopes: scopes,
      };
    } catch (error) {
      throw new Error(
        `Failed to get Nango connection: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async getAccessToken(connectorId: string): Promise<string> {
    // For Nango providers, we return the connection ID
    // The actual token is stored in Nango Cloud and retrieved
    // by the sandbox when needed
    return connectorId;
  }

  async deleteConnection(connectorId: string): Promise<void> {
    const nango = globalThis.services.nango;

    // Extract provider type from connection ID
    // Format: "scopeId:providerType"
    const parts = connectorId.split(":");
    if (parts.length < 2) {
      throw new Error(`Invalid Nango connection ID: ${connectorId}`);
    }

    const provider = parts[1];
    if (!provider) {
      throw new Error(`Invalid provider in connection ID: ${connectorId}`);
    }

    try {
      await nango.deleteConnection(provider, connectorId);
    } catch (error) {
      throw new Error(
        `Failed to delete Nango connection: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
}
