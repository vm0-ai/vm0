import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { connectors } from "../schema/connector";
import { secrets } from "../schema/secret";
import { variables } from "../schema/variable";

describe("connector credential storage schema", () => {
  it("keeps rolling-deployment metadata nullable with bigint version storage", () => {
    expect(connectors.storageVersion.notNull).toBe(false);
    expect(connectors.storageVersion.columnType).toBe("PgBigInt53");
    expect(secrets.connectorId.notNull).toBe(false);
    expect(variables.connectorId.notNull).toBe(false);
  });

  it("declares owner indexes, cascade foreign keys, and additive checks", () => {
    const connectorConfig = getTableConfig(connectors);
    const secretConfig = getTableConfig(secrets);
    const variableConfig = getTableConfig(variables);

    expect(
      connectorConfig.checks.map((check) => {
        return check.name;
      }),
    ).toContain("chk_connectors_storage_version_positive");
    expect(
      secretConfig.indexes.map((index) => {
        return index.config.name;
      }),
    ).toContain("idx_secrets_connector");
    expect(
      variableConfig.indexes.map((index) => {
        return index.config.name;
      }),
    ).toContain("idx_variables_connector");
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
