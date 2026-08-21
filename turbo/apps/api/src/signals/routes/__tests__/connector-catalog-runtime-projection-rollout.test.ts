import { env, mockEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-context";
import {
  readConnectorCatalogRuntimeProjectionSchemaAvailable,
  resetDatabasePool,
} from "./helpers/runtime-state";

const context = testContext();

function preMigrationDatabaseUrl(): string {
  const databaseUrl = new URL(env("DATABASE_URL"));
  databaseUrl.pathname = "/template1";
  databaseUrl.search = "";
  databaseUrl.hash = "";
  return databaseUrl.toString();
}

describe("connector catalog runtime projection rollout compatibility", () => {
  it("reports unavailable before migration 0960 and detects schema arrival", async () => {
    const migratedDatabaseUrl = env("DATABASE_URL");
    await resetDatabasePool(context);
    mockEnv("DATABASE_URL", preMigrationDatabaseUrl());

    await expect(
      readConnectorCatalogRuntimeProjectionSchemaAvailable(context),
    ).resolves.toBeFalsy();

    await resetDatabasePool(context);
    mockEnv("DATABASE_URL", migratedDatabaseUrl);

    await expect(
      readConnectorCatalogRuntimeProjectionSchemaAvailable(context),
    ).resolves.toBeTruthy();
  });
});
