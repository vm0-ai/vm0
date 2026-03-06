import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testContext, uniqueId } from "../../__tests__/test-helpers";
import { initServices } from "../../lib/init-services";
import { encryptCredentialValue } from "../../lib/crypto/secrets-encryption";
import { scopes } from "../schema/scope";
import { agentComposes } from "../schema/agent-compose";
import { agentRuns } from "../schema/agent-run";
import { storages } from "../schema/storage";
import { slackInstallations } from "../schema/slack-installation";
import { telegramInstallations } from "../schema/telegram-installation";
import { githubInstallations } from "../schema/github-installation";

const context = testContext();

describe("Scope deletion CASCADE", () => {
  it("should cascade-delete agent_composes, agent_runs, and storages when scope is deleted", async () => {
    context.setupMocks();
    const user = await context.setupUser();
    initServices();
    const db = globalThis.services.db;

    // Create child records
    const [compose] = await db
      .insert(agentComposes)
      .values({
        userId: user.userId,
        scopeId: user.scopeId,
        name: uniqueId("agent"),
      })
      .returning();

    const [run] = await db
      .insert(agentRuns)
      .values({
        userId: user.userId,
        scopeId: user.scopeId,
        status: "completed",
        prompt: "test prompt",
      })
      .returning();

    const [storage] = await db
      .insert(storages)
      .values({
        userId: user.userId,
        scopeId: user.scopeId,
        name: uniqueId("storage"),
        s3Prefix: "test/prefix",
      })
      .returning();

    // Delete the scope
    await db.delete(scopes).where(eq(scopes.id, user.scopeId));

    // Verify all child records are deleted
    const remainingComposes = await db
      .select()
      .from(agentComposes)
      .where(eq(agentComposes.id, compose.id));
    expect(remainingComposes).toHaveLength(0);

    const remainingRuns = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, run.id));
    expect(remainingRuns).toHaveLength(0);

    const remainingStorages = await db
      .select()
      .from(storages)
      .where(eq(storages.id, storage.id));
    expect(remainingStorages).toHaveLength(0);
  });

  it("should cascade-delete installations via scope -> compose -> installation chain", async () => {
    context.setupMocks();
    const user = await context.setupUser();
    initServices();
    const db = globalThis.services.db;
    const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;

    // Create a compose
    const [compose] = await db
      .insert(agentComposes)
      .values({
        userId: user.userId,
        scopeId: user.scopeId,
        name: uniqueId("agent"),
      })
      .returning();

    const encryptedToken = encryptCredentialValue(
      "test-token",
      SECRETS_ENCRYPTION_KEY,
    );

    // Create installations linked to compose
    const [slack] = await db
      .insert(slackInstallations)
      .values({
        slackWorkspaceId: uniqueId("T"),
        encryptedBotToken: encryptedToken,
        botUserId: uniqueId("U"),
        defaultComposeId: compose.id,
        adminSlackUserId: uniqueId("U"),
      })
      .returning();

    const [telegram] = await db
      .insert(telegramInstallations)
      .values({
        telegramBotId: uniqueId("bot"),
        encryptedBotToken: encryptedToken,
        webhookSecret: uniqueId("secret"),
        defaultComposeId: compose.id,
        adminUserId: user.userId,
      })
      .returning();

    const [github] = await db
      .insert(githubInstallations)
      .values({
        defaultComposeId: compose.id,
      })
      .returning();

    // Delete the scope — should cascade through compose to installations
    await db.delete(scopes).where(eq(scopes.id, user.scopeId));

    // Verify all installations are deleted
    const remainingSlack = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.id, slack.id));
    expect(remainingSlack).toHaveLength(0);

    const remainingTelegram = await db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.id, telegram.id));
    expect(remainingTelegram).toHaveLength(0);

    const remainingGithub = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.id, github.id));
    expect(remainingGithub).toHaveLength(0);
  });
});
