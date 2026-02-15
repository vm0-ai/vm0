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
    // TODO: Implement correct Nango SDK API call
    // The exact API may vary depending on Nango SDK version
    // Reference: https://docs.nango.dev/integrate/guides/authorize-an-api
    const nango = globalThis.services.nango;

    // Placeholder implementation - will be updated when Nango is configured
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authUrl = (nango as any).getAuthorizationURL?.(
      params.type,
      params.connectionId,
      {
        state: params.state,
      },
    ) as string;

    if (!authUrl) {
      throw new Error("Nango SDK getAuthorizationURL not available");
    }

    return authUrl;
  }

  async handleCallback(params: CallbackParams): Promise<ConnectorResult> {
    const nango = globalThis.services.nango;

    // Nango automatically exchanges the code for a token
    // and stores it in their cloud. We just verify the connection exists.
    try {
      const connection = await nango.getConnection(
        params.type,
        params.connectionId,
      );

      // Extract user info from connection metadata
      // Nango stores OAuth user info in the metadata field
      const metadata = connection.metadata as {
        id?: string;
        username?: string;
        email?: string;
        scopes?: string[];
      };

      return {
        externalId: metadata.id ?? params.connectionId,
        externalUsername: metadata.username ?? null,
        externalEmail: metadata.email ?? null,
        oauthScopes: metadata.scopes ?? null,
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
