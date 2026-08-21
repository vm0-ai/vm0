import { env, mockEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-context";
import {
  readBrowserScreenshotSchemaAvailable,
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

describe("browser screenshot rollout compatibility", () => {
  it("detects both sides of migration 0809 through the test API", async () => {
    await expect(
      readBrowserScreenshotSchemaAvailable(context),
    ).resolves.toBeTruthy();

    const preMigrationUrl = preMigrationDatabaseUrl();
    await resetDatabasePool(context);
    mockEnv("DATABASE_URL", preMigrationUrl);

    await expect(
      readBrowserScreenshotSchemaAvailable(context),
    ).resolves.toBeFalsy();
  });
});
