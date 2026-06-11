import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { afterEach, describe, it } from "vitest";
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

// BDD migration of the legacy
// `integrations-telegram-delete.test.ts`. The 15 legacy
// `it()`s collapse into 3 BDD `it()`s:
// (1) auth + role + not-found chain (401 unauth → 403
// official bot → 404 unknown bot → 404 cross-org → 403
// non-admin non-owner),
// (2) disconnect + cascade chain (204 owner disconnects
// + 204 admin disconnects + 204 webhook-removal failure
// + 204 cascades links/messages/threads),
// (3) unlink chain (401 unauth → 404 no link → 204
// deletes custom link → 204 botId filter deletes only
// that link → 204 official botId filter → 204
// cross-org isolation).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const AUTH_HEADERS = { authorization: "Bearer clerk-session" } as const;

interface SeededBot extends TelegramFixture {
  readonly botId: string;
  readonly composeId: string;
  readonly ownerUserId: string;
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
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

function apiClient() {
  return setupApp({ context })(zeroIntegrationsTelegramContract);
}

describe("BDD DELETE /api/integrations/telegram/:botId — auth + role + not-found chain", () => {
  const fixtures: TelegramFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteTelegramFixture$, fixture, context.signal);
      }
    }
  });

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

  it("gwt-wt-wt: 401 unauth → 403 official bot → 404 unknown bot → 404 cross-org → 403 non-admin non-owner", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      apiClient().disconnect({
        params: { botId: newId("bot") },
        headers: {},
      }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: an admin session + the official bot id.

    // When + Then: 403 — official bot cannot be
    // uninstalled.
    const officialUserId = newId("user");
    const officialOrgId = newId("org");
    mocks.clerk.session(officialUserId, officialOrgId, "org:admin");
    const officialResponse = await accept(
      apiClient().disconnect({
        params: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
      }),
      [403],
    );
    expect(officialResponse.body).toStrictEqual({
      error: {
        message: "The official Telegram bot cannot be uninstalled",
        code: "FORBIDDEN",
      },
    });

    // Given: an admin session + a bot id that does
    // not exist.

    // When + Then: 404.
    mocks.clerk.session(newId("user"), newId("org"), "org:admin");
    const unknownResponse = await accept(
      apiClient().disconnect({
        params: { botId: newId("missing-bot") },
        headers: AUTH_HEADERS,
      }),
      [404],
    );
    expect(unknownResponse.body).toStrictEqual({
      error: { message: "Telegram bot not found", code: "NOT_FOUND" },
    });

    // Given: a seeded bot + an admin session in a
    // different org.

    // When + Then: 404 — cross-org isolation.
    const crossOrgBot = await seedBot();
    mocks.clerk.session(
      crossOrgBot.ownerUserId,
      newId("other-org"),
      "org:admin",
    );
    const crossOrgResponse = await accept(
      apiClient().disconnect({
        params: { botId: crossOrgBot.botId },
        headers: AUTH_HEADERS,
      }),
      [404],
    );
    expect(crossOrgResponse.body.error.code).toBe("NOT_FOUND");

    // Given: a seeded bot + a non-owner member in
    // the same org.

    // When + Then: 403 — only the owner or an org
    // admin can uninstall.
    const nonAdminBot = await seedBot({ ownerUserId: newId("owner") });
    mocks.clerk.session(newId("member"), nonAdminBot.orgId, "org:member");
    const nonAdminResponse = await accept(
      apiClient().disconnect({
        params: { botId: nonAdminBot.botId },
        headers: AUTH_HEADERS,
      }),
      [403],
    );
    expect(nonAdminResponse.body).toStrictEqual({
      error: {
        message: "Only the bot owner or an org admin can uninstall this bot",
        code: "FORBIDDEN",
      },
    });
  });
});

describe("BDD DELETE /api/integrations/telegram/:botId — disconnect + cascade chain", () => {
  const fixtures: TelegramFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteTelegramFixture$, fixture, context.signal);
      }
    }
  });

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

  it("gwt-wt-wt: 204 owner disconnects + 204 admin disconnects + 204 webhook-removal failure + 204 cascades links/messages/threads", async () => {
    // Given: a seeded bot + the bot owner in the same
    // org as a member.

    // When + Then: 204 — installation removed +
    // deleteWebhook called with the bot token +
    // installation count is 0 + the telegram:changed
    // realtime event is published with a null payload.
    const ownerBot = await seedBot();
    mocks.clerk.session(ownerBot.ownerUserId, ownerBot.orgId, "org:member");
    const ownerResponse = await apiClient().disconnect({
      params: { botId: ownerBot.botId },
      headers: AUTH_HEADERS,
    });
    expect(ownerResponse.status).toBe(204);
    expect(context.mocks.telegram.deleteWebhook).toHaveBeenCalledTimes(1);
    expect(context.mocks.telegram.deleteWebhook).toHaveBeenCalledWith(
      "test-bot-token",
    );
    await expect(countInstallations(ownerBot.botId)).resolves.toBe(0);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "telegram:changed",
      null,
    );

    // Given: a seeded bot owned by a different user +
    // an org admin session in the same org.

    // When + Then: 204 — admin can uninstall +
    // deleteWebhook is called + installation count
    // is 0.
    const adminBot = await seedBot({ ownerUserId: newId("owner") });
    mocks.clerk.session(newId("admin"), adminBot.orgId, "org:admin");
    const adminResponse = await apiClient().disconnect({
      params: { botId: adminBot.botId },
      headers: AUTH_HEADERS,
    });
    expect(adminResponse.status).toBe(204);
    expect(context.mocks.telegram.deleteWebhook).toHaveBeenCalledTimes(2);
    await expect(countInstallations(adminBot.botId)).resolves.toBe(0);

    // Given: a seeded bot + a webhook-removal failure
    // from the Telegram mock + an admin session.

    // When + Then: 204 — the local installation is
    // still removed despite the upstream failure +
    // deleteWebhook is called + count is 0.
    const failingBot = await seedBot();
    mocks.clerk.session(failingBot.ownerUserId, failingBot.orgId, "org:admin");
    context.mocks.telegram.deleteWebhook.mockRejectedValueOnce(
      new Error("Telegram unavailable"),
    );
    const failingResponse = await apiClient().disconnect({
      params: { botId: failingBot.botId },
      headers: AUTH_HEADERS,
    });
    expect(failingResponse.status).toBe(204);
    expect(context.mocks.telegram.deleteWebhook).toHaveBeenCalledTimes(3);
    await expect(countInstallations(failingBot.botId)).resolves.toBe(0);

    // Given: a seeded bot + a user link + a
    // telegram message + an agent thread session +
    // an admin session.

    // When + Then: 204 — the user link, message, and
    // thread session are all cascaded away.
    const cascadeBot = await seedBot();
    const telegramUserId = "99077";
    const userLinkId = await insertUserLink({
      installationId: cascadeBot.botId,
      userId: cascadeBot.ownerUserId,
      telegramUserId,
    });
    const writeDb = store.set(writeDb$);
    await writeDb.insert(telegramMessages).values({
      installationId: cascadeBot.botId,
      chatId: "77001",
      messageId: "88001",
      fromUserId: telegramUserId,
      text: "before delete",
    });
    await seedThreadSession({
      userId: cascadeBot.ownerUserId,
      orgId: cascadeBot.orgId,
      composeId: cascadeBot.composeId,
      userLinkId,
      chatId: "77001",
      rootMessageId: "dm",
    });
    mocks.clerk.session(cascadeBot.ownerUserId, cascadeBot.orgId, "org:admin");
    const cascadeResponse = await apiClient().disconnect({
      params: { botId: cascadeBot.botId },
      headers: AUTH_HEADERS,
    });
    expect(cascadeResponse.status).toBe(204);
    await expect(
      userLinkExists({
        installationId: cascadeBot.botId,
        telegramUserId,
      }),
    ).resolves.toBeFalsy();
    await expect(countMessages(cascadeBot.botId)).resolves.toBe(0);
    await expect(
      threadSessionExists({
        userLinkId,
        chatId: "77001",
        rootMessageId: "dm",
      }),
    ).resolves.toBeFalsy();
  });
});

describe("BDD DELETE /api/integrations/telegram/link — unlink chain", () => {
  const fixtures: TelegramFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteTelegramFixture$, fixture, context.signal);
      }
    }
  });

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

  it("gwt-wt-wt: 401 unauth → 404 no link → 204 deletes custom link → 204 botId filter deletes only that link → 204 official botId filter → 204 cross-org isolation", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      apiClient().unlink({ query: {}, headers: {} }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a member session with no link.

    // When + Then: 404 — No linked Telegram account.
    mocks.clerk.session(newId("user"), newId("org"), "org:member");
    const noLinkResponse = await accept(
      apiClient().unlink({ query: {}, headers: AUTH_HEADERS }),
      [404],
    );
    expect(noLinkResponse.body).toStrictEqual({
      error: { message: "No linked Telegram account", code: "NOT_FOUND" },
    });

    // Given: a seeded bot + a user link for the
    // owner + a member session.

    // When + Then: 204 — the link is removed +
    // no links remain for the user + the
    // telegram:changed event is published.
    const linkBot = await seedBot();
    await insertUserLink({
      installationId: linkBot.botId,
      userId: linkBot.ownerUserId,
      telegramUserId: "99001",
    });
    mocks.clerk.session(linkBot.ownerUserId, linkBot.orgId, "org:member");
    const linkResponse = await apiClient().unlink({
      query: {},
      headers: AUTH_HEADERS,
    });
    expect(linkResponse.status).toBe(204);
    await expect(
      linkInstallationsForUser(linkBot.ownerUserId),
    ).resolves.toStrictEqual([]);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "telegram:changed",
      null,
    );

    // Given: a user with two custom bot links in
    // the same org.

    // When + Then: 204 — unlink with botId only
    // removes the requested link, the other one
    // remains.
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
    const filterResponse = await apiClient().unlink({
      query: { botId: firstBot.botId },
      headers: AUTH_HEADERS,
    });
    expect(filterResponse.status).toBe(204);
    await expect(linkInstallationsForUser(userId)).resolves.toStrictEqual([
      secondBot.botId,
    ]);

    // Given: a user with one official link + one
    // custom link.

    // When + Then: 204 — unlink with the official
    // botId deletes the official link only, the
    // custom link remains.
    const officialBot = await seedBot();
    const officialLinkId = await insertOfficialUserLink({
      orgId: officialBot.orgId,
      userId: officialBot.ownerUserId,
      telegramUserId: "99090",
    });
    await insertUserLink({
      installationId: officialBot.botId,
      userId: officialBot.ownerUserId,
      telegramUserId: "99091",
    });
    mocks.clerk.session(
      officialBot.ownerUserId,
      officialBot.orgId,
      "org:member",
    );
    const officialResponse = await apiClient().unlink({
      query: { botId: OFFICIAL_TELEGRAM_BOT_ID },
      headers: AUTH_HEADERS,
    });
    expect(officialResponse.status).toBe(204);
    await expect(countOfficialLinks(officialLinkId)).resolves.toBe(0);
    await expect(
      linkInstallationsForUser(officialBot.ownerUserId),
    ).resolves.toStrictEqual([officialBot.botId]);

    // Given: a user with one custom link in org A +
    // one custom link in another bot in another org.

    // When + Then: 204 — unlink without botId
    // removes the active-org link only, the
    // other-org link remains untouched.
    const crossUserId = newId("user");
    const activeBot = await seedBot({ ownerUserId: crossUserId });
    const otherBot = await seedBot({ ownerUserId: crossUserId });
    await insertUserLink({
      installationId: activeBot.botId,
      userId: crossUserId,
      telegramUserId: "99101",
    });
    await insertUserLink({
      installationId: otherBot.botId,
      userId: crossUserId,
      telegramUserId: "99102",
    });
    mocks.clerk.session(crossUserId, activeBot.orgId, "org:member");
    const crossResponse = await apiClient().unlink({
      query: {},
      headers: AUTH_HEADERS,
    });
    expect(crossResponse.status).toBe(204);
    await expect(linkInstallationsForUser(crossUserId)).resolves.toStrictEqual([
      otherBot.botId,
    ]);
  });
});
