import { env, mockEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-context";
import {
  readUsagePackInvitationSchemaAvailable,
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

describe("usage pack invitation rollout compatibility", () => {
  it("detects both sides of migration 0877 through the test API", async () => {
    await expect(
      readUsagePackInvitationSchemaAvailable(context),
    ).resolves.toBeTruthy();

    const preMigrationUrl = preMigrationDatabaseUrl();
    await resetDatabasePool(context);
    mockEnv("DATABASE_URL", preMigrationUrl);

    await expect(
      readUsagePackInvitationSchemaAvailable(context),
    ).resolves.toBeFalsy();
  });
});
