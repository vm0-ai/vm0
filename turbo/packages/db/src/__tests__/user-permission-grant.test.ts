import { describe, expect, it } from "vitest";
import { schema } from "../index";
import { userPermissionGrants } from "../schema/user-permission-grant";

interface NamedExtraConfig {
  readonly name?: unknown;
  readonly config?: {
    readonly name?: unknown;
  };
}

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
    .map((config: NamedExtraConfig) => {
      if (typeof config.name === "string") {
        return config.name;
      }
      if (typeof config.config?.name === "string") {
        return config.config.name;
      }
      return undefined;
    })
    .filter((name: string | undefined): name is string => {
      return Boolean(name);
    });
}

describe("userPermissionGrants schema", () => {
  it("exports the table through the shared schema", () => {
    expect(schema.userPermissionGrants).toBe(userPermissionGrants);
  });

  it("keeps the expected grant column names stable", () => {
    expect(userPermissionGrants.orgId.name).toBe("org_id");
    expect(userPermissionGrants.userId.name).toBe("user_id");
    expect(userPermissionGrants.agentId.name).toBe("agent_id");
    expect(userPermissionGrants.connectorRef.name).toBe("connector_ref");
    expect(userPermissionGrants.permission.name).toBe("permission");
    expect(userPermissionGrants.action.name).toBe("action");
    expect(userPermissionGrants.expiresAt.name).toBe("expires_at");
    expect(userPermissionGrants.createdAt.name).toBe("created_at");
    expect(userPermissionGrants.updatedAt.name).toBe("updated_at");
  });

  it("declares grant uniqueness, lookup, and action checks", () => {
    expect(getExtraConfigNames(userPermissionGrants)).toEqual(
      expect.arrayContaining([
        "uq_user_permission_grants_grant",
        "idx_user_permission_grants_lookup",
        "chk_user_permission_grants_action",
      ]),
    );
  });
});
