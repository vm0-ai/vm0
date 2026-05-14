import { describe, expect, it } from "vitest";
import { schema } from "../index";
import { connectorCliAuthSessions } from "../schema/connector-cli-auth-session";

function getExtraConfigNames(table: object): string[] {
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

  return builder(columns)
    .map((config: { name?: string; config?: { name?: string } }) => {
      return config.name ?? config.config?.name;
    })
    .filter((name: string | undefined): name is string => {
      return Boolean(name);
    });
}

describe("connectorCliAuthSessions schema", () => {
  it("exports the CLI auth session table through the shared schema", () => {
    expect(schema.connectorCliAuthSessions).toBe(connectorCliAuthSessions);
  });

  it("keeps the expected column names stable", () => {
    expect(connectorCliAuthSessions.id.name).toBe("id");
    expect(connectorCliAuthSessions.orgId.name).toBe("org_id");
    expect(connectorCliAuthSessions.userId.name).toBe("user_id");
    expect(connectorCliAuthSessions.connectorType.name).toBe("connector_type");
    expect(connectorCliAuthSessions.source.name).toBe("source");
    expect(connectorCliAuthSessions.status.name).toBe("status");
    expect(connectorCliAuthSessions.sandboxId.name).toBe("sandbox_id");
    expect(connectorCliAuthSessions.approvalUrl.name).toBe("approval_url");
    expect(connectorCliAuthSessions.verificationCode.name).toBe(
      "verification_code",
    );
    expect(connectorCliAuthSessions.encryptedProviderState.name).toBe(
      "encrypted_provider_state",
    );
    expect(connectorCliAuthSessions.errorMessage.name).toBe("error_message");
    expect(connectorCliAuthSessions.createdAt.name).toBe("created_at");
    expect(connectorCliAuthSessions.updatedAt.name).toBe("updated_at");
    expect(connectorCliAuthSessions.expiresAt.name).toBe("expires_at");
    expect(connectorCliAuthSessions.completedAt.name).toBe("completed_at");
    expect(connectorCliAuthSessions.cancelledAt.name).toBe("cancelled_at");
  });

  it("declares lifecycle lookup indexes", () => {
    expect(getExtraConfigNames(connectorCliAuthSessions)).toEqual(
      expect.arrayContaining([
        "idx_connector_cli_auth_sessions_owner_status",
        "idx_connector_cli_auth_sessions_expiration",
        "idx_connector_cli_auth_sessions_sandbox",
      ]),
    );
  });
});
