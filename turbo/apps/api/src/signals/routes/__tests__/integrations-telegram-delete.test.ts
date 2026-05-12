import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { afterEach, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import {
  OFFICIAL_TELEGRAM_BOT_ID,
  zeroIntegrationsTelegramContract,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import { telegramOfficialUserLinks } from "@vm0/db/schema/telegram-official-user-link";
import { telegramThreadSessions } from "@vm0/db/schema/telegram-thread-session";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteTelegramFixture$,
  seedTelegramInstallation$,
  type TelegramFixture,
} from "./helpers/zero-telegram";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const AUTH_HEADERS = { authorization: "Bearer clerk-session" } as const;

interface SeededBot extends TelegramFixture {
  readonly botId: string;
  readonly composeId: string;
  readonly ownerUserId: string;
}

describe("DELETE /api/integrations/telegram", () => {
  const fixtures: TelegramFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteTelegramFixture$, fixture, context.signal);
      }
    }
  });

  function newId(prefix: string): string {
    return `${prefix}_${randomUUID().slice(0, 8)}`;
  }

  async function seedBot(
    args: {
      readonly orgId?: string;
      readonly ownerUserId?: string;
      readonly botId?: string;
    } = {},
  ): Promise<SeededBot> {
    const orgId = args.orgId ?? newId("org");
    const ownerUserId = args.ownerUserId ?? newId("user");
    const botId = args.botId ?? newId("bot");
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId, telegramBotId: botId },
      context.signal,
    );
    const fixture = {
      orgId,
      composeIds: [installation.composeId],
      telegramBotIds: [botId],
      userIds: [ownerUserId],
      botId,
      composeId: installation.composeId,
      ownerUserId,
    };
    fixtures.push(fixture);
    return fixture;
  }

  function client() {
    return setupApp({ context })(zeroIntegrationsTelegramContract);
  }

  function requireInsertedRow<T>(row: T | undefined, label: string): T {
    if (!row) {
      throw new Error(`Failed to insert ${label}`);
    }
    return row;
  }

  async function insertUserLink(args: {
    readonly installationId: string;
    readonly userId: string;
    readonly telegramUserId?: string;
  }): Promise<string> {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .insert(telegramUserLinks)
      .values({
        installationId: args.installationId,
        vm0UserId: args.userId,
        telegramUserId: args.telegramUserId ?? newId("telegram-user"),
      })
      .returning({ id: telegramUserLinks.id });
    return requireInsertedRow(row, "Telegram user link").id;
  }

  async function insertOfficialUserLink(args: {
    readonly orgId: string;
    readonly userId: string;
    readonly telegramUserId?: string;
  }): Promise<string> {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .insert(telegramOfficialUserLinks)
      .values({
        orgId: args.orgId,
        vm0UserId: args.userId,
        telegramUserId: args.telegramUserId ?? newId("telegram-official-user"),
      })
      .returning({ id: telegramOfficialUserLinks.id });
    return requireInsertedRow(row, "official Telegram user link").id;
  }

  async function countInstallations(botId: string): Promise<number> {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ value: count() })
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, botId));
    return row?.value ?? 0;
  }

  async function countMessages(installationId: string): Promise<number> {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ value: count() })
      .from(telegramMessages)
      .where(eq(telegramMessages.installationId, installationId));
    return row?.value ?? 0;
  }

  async function countOfficialLinks(id: string): Promise<number> {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ value: count() })
      .from(telegramOfficialUserLinks)
      .where(eq(telegramOfficialUserLinks.id, id));
    return row?.value ?? 0;
  }

  async function linkInstallationsForUser(userId: string): Promise<string[]> {
    const writeDb = store.set(writeDb$);
    const rows = await writeDb
      .select({ installationId: telegramUserLinks.installationId })
      .from(telegramUserLinks)
      .where(eq(telegramUserLinks.vm0UserId, userId));
    return rows
      .map((row) => {
        return row.installationId;
      })
      .sort();
  }

  async function userLinkExists(args: {
    readonly installationId: string;
    readonly telegramUserId: string;
  }): Promise<boolean> {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ id: telegramUserLinks.id })
      .from(telegramUserLinks)
      .where(
        and(
          eq(telegramUserLinks.installationId, args.installationId),
          eq(telegramUserLinks.telegramUserId, args.telegramUserId),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async function threadSessionExists(args: {
    readonly userLinkId: string;
    readonly chatId: string;
    readonly rootMessageId: string;
  }): Promise<boolean> {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ id: telegramThreadSessions.id })
      .from(telegramThreadSessions)
      .where(
        and(
          eq(telegramThreadSessions.telegramUserLinkId, args.userLinkId),
          eq(telegramThreadSessions.chatId, args.chatId),
          eq(telegramThreadSessions.rootMessageId, args.rootMessageId),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async function seedThreadSession(args: {
    readonly userId: string;
    readonly orgId: string;
    readonly composeId: string;
    readonly userLinkId: string;
    readonly chatId: string;
    readonly rootMessageId: string;
  }): Promise<void> {
    const writeDb = store.set(writeDb$);
    const [session] = await writeDb
      .insert(agentSessions)
      .values({
        userId: args.userId,
        orgId: args.orgId,
        agentComposeId: args.composeId,
      })
      .returning({ id: agentSessions.id });
    const insertedSession = requireInsertedRow(session, "agent session");

    await writeDb.insert(telegramThreadSessions).values({
      telegramUserLinkId: args.userLinkId,
      chatId: args.chatId,
      rootMessageId: args.rootMessageId,
      agentSessionId: insertedSession.id,
    });
  }

  describe("DELETE /api/integrations/telegram/:botId", () => {
    it("returns 401 when unauthenticated", async () => {
      const response = await accept(
        client().disconnect({
          params: { botId: newId("bot") },
          headers: {},
        }),
        [401],
      );

      expect(response.body).toStrictEqual({
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      });
    });

    it("returns 403 when uninstalling the official bot", async () => {
      const userId = newId("user");
      const orgId = newId("org");
      mocks.clerk.session(userId, orgId, "org:admin");

      const response = await accept(
        client().disconnect({
          params: { botId: OFFICIAL_TELEGRAM_BOT_ID },
          headers: AUTH_HEADERS,
        }),
        [403],
      );

      expect(response.body).toStrictEqual({
        error: {
          message: "The official Telegram bot cannot be uninstalled",
          code: "FORBIDDEN",
        },
      });
    });

    it("returns 404 for an unknown bot", async () => {
      mocks.clerk.session(newId("user"), newId("org"), "org:admin");

      const response = await accept(
        client().disconnect({
          params: { botId: newId("missing-bot") },
          headers: AUTH_HEADERS,
        }),
        [404],
      );

      expect(response.body).toStrictEqual({
        error: { message: "Telegram bot not found", code: "NOT_FOUND" },
      });
    });

    it("returns 404 for a bot in another org", async () => {
      const bot = await seedBot();
      mocks.clerk.session(bot.ownerUserId, newId("other-org"), "org:admin");

      const response = await accept(
        client().disconnect({
          params: { botId: bot.botId },
          headers: AUTH_HEADERS,
        }),
        [404],
      );

      expect(response.body.error.code).toBe("NOT_FOUND");
    });

    it("returns 403 for a non-admin non-owner", async () => {
      const bot = await seedBot({ ownerUserId: newId("owner") });
      mocks.clerk.session(newId("member"), bot.orgId, "org:member");

      const response = await accept(
        client().disconnect({
          params: { botId: bot.botId },
          headers: AUTH_HEADERS,
        }),
        [403],
      );

      expect(response.body).toStrictEqual({
        error: {
          message: "Only the bot owner or an org admin can uninstall this bot",
          code: "FORBIDDEN",
        },
      });
    });

    it("deletes the installation for the owner and removes the webhook", async () => {
      const bot = await seedBot();
      mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:member");

      const response = await client().disconnect({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
      });

      expect(response.status).toBe(204);
      expect(context.mocks.telegram.deleteWebhook).toHaveBeenCalledTimes(1);
      expect(context.mocks.telegram.deleteWebhook).toHaveBeenCalledWith(
        "test-bot-token",
      );
      await expect(countInstallations(bot.botId)).resolves.toBe(0);
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        "telegram:changed",
        null,
      );
    });

    it("deletes the installation for an org admin", async () => {
      const bot = await seedBot({ ownerUserId: newId("owner") });
      mocks.clerk.session(newId("admin"), bot.orgId, "org:admin");

      const response = await client().disconnect({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
      });

      expect(response.status).toBe(204);
      expect(context.mocks.telegram.deleteWebhook).toHaveBeenCalledTimes(1);
      await expect(countInstallations(bot.botId)).resolves.toBe(0);
    });

    it("deletes the installation when webhook removal fails", async () => {
      const bot = await seedBot();
      mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:admin");
      context.mocks.telegram.deleteWebhook.mockRejectedValueOnce(
        new Error("Telegram unavailable"),
      );

      const response = await client().disconnect({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
      });

      expect(response.status).toBe(204);
      expect(context.mocks.telegram.deleteWebhook).toHaveBeenCalledTimes(1);
      await expect(countInstallations(bot.botId)).resolves.toBe(0);
    });

    it("cascades links, messages, and thread sessions for the deleted bot", async () => {
      const bot = await seedBot();
      const telegramUserId = "99077";
      const userLinkId = await insertUserLink({
        installationId: bot.botId,
        userId: bot.ownerUserId,
        telegramUserId,
      });
      const writeDb = store.set(writeDb$);
      await writeDb.insert(telegramMessages).values({
        installationId: bot.botId,
        chatId: "77001",
        messageId: "88001",
        fromUserId: telegramUserId,
        text: "before delete",
      });
      await seedThreadSession({
        userId: bot.ownerUserId,
        orgId: bot.orgId,
        composeId: bot.composeId,
        userLinkId,
        chatId: "77001",
        rootMessageId: "dm",
      });
      mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:admin");

      const response = await client().disconnect({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
      });

      expect(response.status).toBe(204);
      await expect(
        userLinkExists({ installationId: bot.botId, telegramUserId }),
      ).resolves.toBeFalsy();
      await expect(countMessages(bot.botId)).resolves.toBe(0);
      await expect(
        threadSessionExists({
          userLinkId,
          chatId: "77001",
          rootMessageId: "dm",
        }),
      ).resolves.toBeFalsy();
    });
  });

  describe("DELETE /api/integrations/telegram/link", () => {
    it("returns 401 when unauthenticated", async () => {
      const response = await accept(
        client().unlink({ query: {}, headers: {} }),
        [401],
      );

      expect(response.body).toStrictEqual({
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      });
    });

    it("returns 404 when the user has no link", async () => {
      mocks.clerk.session(newId("user"), newId("org"), "org:member");

      const response = await accept(
        client().unlink({ query: {}, headers: AUTH_HEADERS }),
        [404],
      );

      expect(response.body).toStrictEqual({
        error: { message: "No linked Telegram account", code: "NOT_FOUND" },
      });
    });

    it("deletes the user's custom bot link", async () => {
      const bot = await seedBot();
      await insertUserLink({
        installationId: bot.botId,
        userId: bot.ownerUserId,
        telegramUserId: "99001",
      });
      mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:member");

      const response = await client().unlink({
        query: {},
        headers: AUTH_HEADERS,
      });

      expect(response.status).toBe(204);
      await expect(
        linkInstallationsForUser(bot.ownerUserId),
      ).resolves.toStrictEqual([]);
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        "telegram:changed",
        null,
      );
    });

    it("deletes only the requested custom bot link when botId is provided", async () => {
      const orgId = newId("org");
      const userId = newId("user");
      const firstBot = await seedBot({ orgId, ownerUserId: userId });
      const secondBot = await seedBot({ orgId, ownerUserId: userId });
      await insertUserLink({
        installationId: firstBot.botId,
        userId,
        telegramUserId: "99011",
      });
      await insertUserLink({
        installationId: secondBot.botId,
        userId,
        telegramUserId: "99012",
      });
      mocks.clerk.session(userId, orgId, "org:member");

      const response = await client().unlink({
        query: { botId: firstBot.botId },
        headers: AUTH_HEADERS,
      });

      expect(response.status).toBe(204);
      await expect(linkInstallationsForUser(userId)).resolves.toStrictEqual([
        secondBot.botId,
      ]);
    });

    it("deletes only the official link when botId is official", async () => {
      const bot = await seedBot();
      const officialLinkId = await insertOfficialUserLink({
        orgId: bot.orgId,
        userId: bot.ownerUserId,
        telegramUserId: "99090",
      });
      await insertUserLink({
        installationId: bot.botId,
        userId: bot.ownerUserId,
        telegramUserId: "99091",
      });
      mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:member");

      const response = await client().unlink({
        query: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
      });

      expect(response.status).toBe(204);
      await expect(countOfficialLinks(officialLinkId)).resolves.toBe(0);
      await expect(
        linkInstallationsForUser(bot.ownerUserId),
      ).resolves.toStrictEqual([bot.botId]);
    });

    it("does not delete custom links from another org", async () => {
      const userId = newId("user");
      const activeBot = await seedBot({ ownerUserId: userId });
      const otherBot = await seedBot({ ownerUserId: userId });
      await insertUserLink({
        installationId: activeBot.botId,
        userId,
        telegramUserId: "99101",
      });
      await insertUserLink({
        installationId: otherBot.botId,
        userId,
        telegramUserId: "99102",
      });
      mocks.clerk.session(userId, activeBot.orgId, "org:member");

      const response = await client().unlink({
        query: {},
        headers: AUTH_HEADERS,
      });

      expect(response.status).toBe(204);
      await expect(linkInstallationsForUser(userId)).resolves.toStrictEqual([
        otherBot.botId,
      ]);
    });
  });
});
