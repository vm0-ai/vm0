import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { connectors } from "../schema/connector";
import { secrets } from "../schema/secret";
import { variables } from "../schema/variable";

describe("connector credential storage schema", () => {
  it("requires connector versions while shared owner columns stay nullable", () => {
    expect(connectors.storageVersion.notNull).toBe(true);
    expect(connectors.storageVersion.columnType).toBe("PgBigInt53");
    expect(secrets.connectorId.notNull).toBe(false);
    expect(variables.connectorId.notNull).toBe(false);
  });

  it("declares owner indexes, cascade foreign keys, and final checks", () => {
    const connectorConfig = getTableConfig(connectors);
    const secretConfig = getTableConfig(secrets);
    const variableConfig = getTableConfig(variables);

    expect(
      connectorConfig.checks.map((check) => {
        return check.name;
      }),
    ).toContain("chk_connectors_storage_version_positive");
    const secretOwnerIndex = secretConfig.indexes.find((index) => {
      return index.config.name === "idx_secrets_connector";
    });
    const variableOwnerIndex = variableConfig.indexes.find((index) => {
      return index.config.name === "idx_variables_connector";
    });
    expect(secretOwnerIndex?.config.where).toBeDefined();
    expect(variableOwnerIndex?.config.where).toBeDefined();
    expect(
      secretConfig.checks.map((check) => {
        return check.name;
      }),
    ).toContain("chk_secrets_connector_owner_type");
    expect(
      variableConfig.checks.map((check) => {
        return check.name;
      }),
    ).toContain("chk_variables_connector_owner_type");
    expect(secretConfig.foreignKeys).toHaveLength(1);
    expect(secretConfig.foreignKeys[0]?.onDelete).toBe("cascade");
    expect(variableConfig.foreignKeys).toHaveLength(1);
    expect(variableConfig.foreignKeys[0]?.onDelete).toBe("cascade");
  });
});
