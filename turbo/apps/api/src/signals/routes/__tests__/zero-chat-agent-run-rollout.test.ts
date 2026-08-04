import { env, mockEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-context";
import {
  readChatAgentRunContextSchemaAvailable,
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

describe("chat agent-run context rollout compatibility", () => {
  it("detects both sides of migration 0825 through the test API", async () => {
    await expect(
      readChatAgentRunContextSchemaAvailable(context),
    ).resolves.toBeTruthy();

    const preMigrationUrl = preMigrationDatabaseUrl();
    await resetDatabasePool(context);
    mockEnv("DATABASE_URL", preMigrationUrl);

    await expect(
      readChatAgentRunContextSchemaAvailable(context),
    ).resolves.toBeFalsy();
  });
});
