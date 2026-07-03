import { describe, expect, it } from "vitest";
import { schema } from "../index";
import { connectorOauthDeviceAuthorizationSessions } from "../schema/connector-oauth-device-authorization-session";

interface ExtraConfigColumn {
  readonly name?: string;
}

interface ExtraConfig {
  readonly name?: string;
  readonly config?: {
    readonly name?: string;
    readonly columns?: readonly ExtraConfigColumn[];
  };
}

function isExtraConfig(value: unknown): value is ExtraConfig {
  return typeof value === "object" && value !== null;
}

function getExtraConfigs(table: object): ExtraConfig[] {
  const symbols = Object.getOwnPropertySymbols(table);
  const builderSymbol = symbols.find((symbol) => {
    return symbol.description === "drizzle:ExtraConfigBuilder";
  });
  const columnsSymbol = symbols.find((symbol) => {
    return symbol.description === "drizzle:ExtraConfigColumns";
  });
  if (!builderSymbol || !columnsSymbol) {
    return [];
  }

  const builder = Reflect.get(table, builderSymbol);
  const columns = Reflect.get(table, columnsSymbol);
  if (typeof builder !== "function") {
    return [];
  }

  const result: unknown = builder(columns);
  if (!Array.isArray(result)) {
    return [];
  }
  return result.filter(isExtraConfig);
}

function getExtraConfigNames(table: object): string[] {
  return getExtraConfigs(table)
    .map((config) => {
      return config.name ?? config.config?.name;
    })
    .filter((name: string | undefined): name is string => {
      return Boolean(name);
    });
}

function getExtraConfigColumnNames(table: object, name: string): string[] {
  const config = getExtraConfigs(table).find((item) => {
    return (item.name ?? item.config?.name) === name;
  });
  return (
    config?.config?.columns
      ?.map((column) => {
        return column.name;
      })
      .filter((columnName: string | undefined): columnName is string => {
        return Boolean(columnName);
      }) ?? []
  );
}

describe("connectorOauthDeviceAuthorizationSessions schema", () => {
  it("exports the OAuth device authorization session table", () => {
    expect(schema.connectorOauthDeviceAuthorizationSessions).toBe(
      connectorOauthDeviceAuthorizationSessions,
    );
  });

  it("keeps the expected column names stable", () => {
    expect(connectorOauthDeviceAuthorizationSessions.id.name).toBe("id");
    expect(connectorOauthDeviceAuthorizationSessions.orgId.name).toBe("org_id");
    expect(connectorOauthDeviceAuthorizationSessions.userId.name).toBe(
      "user_id",
    );
    expect(connectorOauthDeviceAuthorizationSessions.connectorType.name).toBe(
      "connector_type",
    );
    expect(connectorOauthDeviceAuthorizationSessions.authMethod.name).toBe(
      "auth_method",
    );
    expect(connectorOauthDeviceAuthorizationSessions.status.name).toBe(
      "status",
    );
    expect(
      connectorOauthDeviceAuthorizationSessions.sessionTokenHash.name,
    ).toBe("session_token_hash");
    expect(
      connectorOauthDeviceAuthorizationSessions.encryptedProviderState.name,
    ).toBe("encrypted_provider_state");
    expect(connectorOauthDeviceAuthorizationSessions.userCode.name).toBe(
      "user_code",
    );
    expect(connectorOauthDeviceAuthorizationSessions.verificationUri.name).toBe(
      "verification_uri",
    );
    expect(
      connectorOauthDeviceAuthorizationSessions.verificationUriComplete.name,
    ).toBe("verification_uri_complete");
    expect(connectorOauthDeviceAuthorizationSessions.intervalSeconds.name).toBe(
      "interval_seconds",
    );
    expect(connectorOauthDeviceAuthorizationSessions.errorCode.name).toBe(
      "error_code",
    );
    expect(connectorOauthDeviceAuthorizationSessions.errorMessage.name).toBe(
      "error_message",
    );
    expect(connectorOauthDeviceAuthorizationSessions.createdAt.name).toBe(
      "created_at",
    );
    expect(connectorOauthDeviceAuthorizationSessions.updatedAt.name).toBe(
      "updated_at",
    );
    expect(connectorOauthDeviceAuthorizationSessions.expiresAt.name).toBe(
      "expires_at",
    );
    expect(connectorOauthDeviceAuthorizationSessions.completedAt.name).toBe(
      "completed_at",
    );
  });

  it("declares token, owner, and expiration indexes", () => {
    expect(
      getExtraConfigNames(connectorOauthDeviceAuthorizationSessions),
    ).toStrictEqual(
      expect.arrayContaining([
        "idx_connector_oauth_device_authorization_sessions_token",
        "idx_connector_oauth_device_authorization_sessions_owner_status",
        "idx_connector_oauth_device_authorization_sessions_expiration",
      ]),
    );
    expect(
      getExtraConfigColumnNames(
        connectorOauthDeviceAuthorizationSessions,
        "idx_connector_oauth_device_authorization_sessions_owner_status",
      ),
    ).toStrictEqual([
      "org_id",
      "user_id",
      "connector_type",
      "auth_method",
      "status",
    ]);
  });
});
