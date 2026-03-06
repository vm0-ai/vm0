import { describe, it, expect } from "vitest";
import { testContext, uniqueId } from "../../__tests__/test-helpers";
import {
  insertTestAgentCompose,
  insertTestAgentRun,
  insertTestStorageRecord,
  deleteTestScope,
  findTestAgentComposeById,
  findTestAgentRunById,
  findTestStorageById,
  insertTestSlackInstallation,
  insertTestTelegramInstallationRecord,
  insertTestGitHubInstallation,
  findTestSlackInstallationById,
  findTestTelegramInstallationById,
  findTestGitHubInstallationById,
} from "../../__tests__/api-test-helpers";
import { encryptCredentialValue } from "../../lib/crypto/secrets-encryption";
import { env } from "../../env";

const context = testContext();

describe("Scope deletion CASCADE", () => {
  it("should cascade-delete agent_composes, agent_runs, and storages when scope is deleted", async () => {
    context.setupMocks();
    const user = await context.setupUser();

    // Create child records
    const compose = await insertTestAgentCompose(
      user.userId,
      user.scopeId,
      uniqueId("agent"),
    );

    const run = await insertTestAgentRun(user.userId, user.scopeId);

    const storage = await insertTestStorageRecord(
      user.userId,
      user.scopeId,
      uniqueId("storage"),
    );

    // Delete the scope
    await deleteTestScope(user.scopeId);

    // Verify all child records are deleted
    expect(await findTestAgentComposeById(compose.id)).toBeUndefined();
    expect(await findTestAgentRunById(run.id)).toBeUndefined();
    expect(await findTestStorageById(storage.id)).toBeUndefined();
  });

  it("should cascade-delete installations via scope -> compose -> installation chain", async () => {
    context.setupMocks();
    const user = await context.setupUser();
    const { SECRETS_ENCRYPTION_KEY } = env();

    // Create a compose
    const compose = await insertTestAgentCompose(
      user.userId,
      user.scopeId,
      uniqueId("agent"),
    );

    const encryptedToken = encryptCredentialValue(
      "test-token",
      SECRETS_ENCRYPTION_KEY,
    );

    // Create installations linked to compose
    const slack = await insertTestSlackInstallation(compose.id, encryptedToken);

    const telegram = await insertTestTelegramInstallationRecord(
      compose.id,
      user.userId,
      encryptedToken,
    );

    const github = await insertTestGitHubInstallation(compose.id);

    // Delete the scope — should cascade through compose to installations
    await deleteTestScope(user.scopeId);

    // Verify all installations are deleted
    expect(await findTestSlackInstallationById(slack.id)).toBeUndefined();
    expect(await findTestTelegramInstallationById(telegram.id)).toBeUndefined();
    expect(await findTestGitHubInstallationById(github.id)).toBeUndefined();
  });
});
