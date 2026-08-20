import { env, mockEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-context";
import {
  readUsagePackPurchaseSerializationSchemaAvailable,
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

describe("usage pack purchase rollout compatibility", () => {
  it("keeps new purchase writers unavailable without the 0953 serialization invariant", async () => {
    await expect(
      readUsagePackPurchaseSerializationSchemaAvailable(context),
    ).resolves.toBeTruthy();

    const preMigrationUrl = preMigrationDatabaseUrl();
    await resetDatabasePool(context);
    mockEnv("DATABASE_URL", preMigrationUrl);

    await expect(
      readUsagePackPurchaseSerializationSchemaAvailable(context),
    ).resolves.toBeFalsy();
  });
});
