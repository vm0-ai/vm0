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
  it("should not cascade-delete agent_composes or agent_runs when scope is deleted (scope_id no longer populated)", async () => {
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

    // Phase 5b-3: scope_id is no longer populated in INSERT operations,
    // so compose records have null scope_id and are not cascade-deleted.
    expect(await findTestAgentComposeById(compose.id)).toBeDefined();

    // agent_runs no longer has FK to scopes (removed in Phase 3 Clerk migration),
    // so the run record is retained after scope deletion
    expect(await findTestAgentRunById(run.id)).toBeDefined();
  });

  it("should not cascade-delete installations when scope is deleted (scope_id no longer populated)", async () => {
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

    // Delete the scope — since scope_id is no longer populated on compose,
    // cascade does not reach compose or its child installations.
    await deleteTestScope(user.scopeId);

    // Phase 5b-3: installations remain because compose.scope_id is null,
    // so the scope -> compose cascade chain is broken.
    expect(await findTestSlackInstallationById(slack.id)).toBeDefined();
    expect(await findTestTelegramInstallationById(telegram.id)).toBeDefined();
    expect(await findTestGitHubInstallationById(github.id)).toBeDefined();
  });
});
