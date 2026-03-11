import { describe, it, expect } from "vitest";
import { testContext, uniqueId } from "../../__tests__/test-helpers";
import {
  insertTestAgentCompose,
  insertTestAgentRun,
  deleteTestScope,
  findTestAgentComposeById,
  findTestAgentRunById,
  insertTestSlackInstallation,
  insertTestTelegramInstallationRecord,
  insertTestGitHubInstallation,
  findTestSlackInstallationById,
  findTestTelegramInstallationById,
  findTestGitHubInstallationById,
} from "../../__tests__/api-test-helpers";
import { encryptSecretValue } from "../../lib/crypto/secrets-encryption";
import { env } from "../../env";

const context = testContext();

describe("Scope deletion CASCADE", () => {
  it("should cascade-delete agent_composes when scope is deleted, but not agent_runs", async () => {
    context.setupMocks();
    const user = await context.setupUser();

    // Create child records
    const compose = await insertTestAgentCompose(
      user.userId,
      user.scopeId,
      uniqueId("agent"),
    );

    const run = await insertTestAgentRun(user.userId, user.scopeId);

    // Delete the scope
    await deleteTestScope(user.scopeId);

    // Verify cascade-deleted child records
    expect(await findTestAgentComposeById(compose.id)).toBeUndefined();

    // agent_runs no longer has FK to scopes (removed in Phase 3 Clerk migration),
    // so the run record is retained after scope deletion
    expect(await findTestAgentRunById(run.id)).toBeDefined();

    // Note: storages no longer cascade-delete via scope — they use clerk_org_id
    // without a foreign key to scopes, so they are cleaned up separately.
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

    const encryptedToken = encryptSecretValue(
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
