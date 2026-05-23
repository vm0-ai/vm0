import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import {
  OFFICIAL_TELEGRAM_BOT_ID,
  zeroIntegrationsTelegramContract,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramUserAgentPreferences } from "@vm0/db/schema/telegram-user-agent-preference";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteTelegramFixture$,
  seedTelegramInstallation$,
  seedUserAgentPreference$,
  type TelegramFixture,
} from "./helpers/zero-telegram";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { server } from "../../../mocks/server";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const AUTH_HEADERS = { authorization: "Bearer clerk-session" } as const;

interface MutableTelegramFixture {
  readonly orgId: string;
  readonly composeIds: string[];
  readonly telegramBotIds: string[];
  readonly userIds: string[];
}

interface SeededBot {
  readonly botId: string;
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly composeId: string;
  readonly fixture: MutableTelegramFixture;
}

describe("PATCH /api/integrations/telegram/:botId", () => {
  const fixtures: MutableTelegramFixture[] = [];

  beforeEach(() => {
    context.mocks.telegram.getMe.mockResolvedValue({
      id: 1,
      is_bot: true,
      first_name: "Bot",
      username: "x",
    });
    server.use(
      http.head("https://oauth.telegram.org/auth", () => {
        return new HttpResponse(null, { status: 200 });
      }),
    );
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(
          deleteTelegramFixture$,
          fixture satisfies TelegramFixture,
          context.signal,
        );
      }
    }
  });

  function client() {
    return setupApp({ context })(zeroIntegrationsTelegramContract);
  }

  function newId(prefix: string): string {
    return `${prefix}_${randomUUID().slice(0, 8)}`;
  }

  function newTelegramBotId(): string {
    return String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000);
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
    const botId = args.botId ?? newTelegramBotId();
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId, telegramBotId: botId },
      context.signal,
    );
    const fixture: MutableTelegramFixture = {
      orgId,
      composeIds: [installation.composeId],
      telegramBotIds: [botId],
      userIds: [ownerUserId],
    };
    fixtures.push(fixture);
    return {
      botId,
      orgId,
      ownerUserId,
      composeId: installation.composeId,
      fixture,
    };
  }

  async function seedCompose(args: {
    readonly orgId: string;
    readonly userId: string;
    readonly name?: string;
    readonly trackWith?: MutableTelegramFixture;
  }): Promise<{ readonly composeId: string; readonly name: string }> {
    const composeId = randomUUID();
    const name = args.name ?? newId("agent");
    const writeDb = store.set(writeDb$);

    await writeDb.insert(agentComposes).values({
      id: composeId,
      userId: args.userId,
      orgId: args.orgId,
      name,
    });
    await writeDb.insert(zeroAgents).values({
      id: composeId,
      orgId: args.orgId,
      owner: args.userId,
      name,
    });

    if (args.trackWith) {
      args.trackWith.composeIds.push(composeId);
    } else {
      fixtures.push({
        orgId: args.orgId,
        composeIds: [composeId],
        telegramBotIds: [],
        userIds: [args.userId],
      });
    }

    return { composeId, name };
  }

  async function defaultComposeId(botId: string): Promise<string | null> {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ defaultComposeId: telegramInstallations.defaultComposeId })
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, botId))
      .limit(1);
    return row?.defaultComposeId ?? null;
  }

  async function selectedPreference(args: {
    readonly orgId: string;
    readonly userId: string;
  }): Promise<string | null | undefined> {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        selectedComposeId: telegramUserAgentPreferences.selectedComposeId,
      })
      .from(telegramUserAgentPreferences)
      .where(
        and(
          eq(telegramUserAgentPreferences.orgId, args.orgId),
          eq(telegramUserAgentPreferences.vm0UserId, args.userId),
        ),
      )
      .limit(1);
    return row?.selectedComposeId;
  }

  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      client().updateBot({
        params: { botId: newTelegramBotId() },
        headers: {},
        body: { defaultAgentId: newId("agent") },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 400 when defaultAgentId is missing for a custom bot", async () => {
    const bot = await seedBot();
    mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:member");

    const response = await accept(
      client().updateBot({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
        body: {},
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: { message: "defaultAgentId is required", code: "BAD_REQUEST" },
    });
  });

  it("returns 403 for a non-admin non-owner custom bot update", async () => {
    const bot = await seedBot({ ownerUserId: newId("owner") });
    mocks.clerk.session(newId("member"), bot.orgId, "org:member");

    const response = await accept(
      client().updateBot({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
        body: { defaultAgentId: bot.composeId },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Only the bot owner or an org admin can change the default agent",
        code: "FORBIDDEN",
      },
    });
  });

  it("updates the default agent for an org admin", async () => {
    const bot = await seedBot({ ownerUserId: newId("owner") });
    const adminUserId = newId("admin");
    const nextAgent = await seedCompose({
      orgId: bot.orgId,
      userId: adminUserId,
      trackWith: bot.fixture,
    });
    mocks.clerk.session(adminUserId, bot.orgId, "org:admin");

    const response = await accept(
      client().updateBot({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
        body: { defaultAgentId: nextAgent.composeId },
      }),
      [200],
    );

    expect(response.body.agent).toStrictEqual({
      id: nextAgent.composeId,
      name: nextAgent.name,
    });
    expect(response.body.id).toBe(bot.botId);
    expect(response.body.isOwner).toBeFalsy();
    await expect(defaultComposeId(bot.botId)).resolves.toBe(
      nextAgent.composeId,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "telegram:changed",
      null,
    );
  });

  it("updates the default agent for the owner", async () => {
    const bot = await seedBot();
    const nextAgent = await seedCompose({
      orgId: bot.orgId,
      userId: bot.ownerUserId,
      trackWith: bot.fixture,
    });
    mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:member");

    const response = await accept(
      client().updateBot({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
        body: { defaultAgentId: nextAgent.composeId },
      }),
      [200],
    );

    expect(response.body.agent).toStrictEqual({
      id: nextAgent.composeId,
      name: nextAgent.name,
    });
    expect(response.body.isOwner).toBeTruthy();
    await expect(defaultComposeId(bot.botId)).resolves.toBe(
      nextAgent.composeId,
    );
  });

  it("returns 403 when defaultAgentId belongs to another org", async () => {
    const bot = await seedBot();
    const otherOrgAgent = await seedCompose({
      orgId: newId("org"),
      userId: bot.ownerUserId,
    });
    mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:member");

    const response = await accept(
      client().updateBot({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
        body: { defaultAgentId: otherOrgAgent.composeId },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Telegram bots can only be connected to agents in the bot's organization",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 404 when the custom bot is not visible in the active org", async () => {
    const bot = await seedBot();
    const otherOrgId = newId("org");
    const otherOrgAgent = await seedCompose({
      orgId: otherOrgId,
      userId: bot.ownerUserId,
    });
    mocks.clerk.session(bot.ownerUserId, otherOrgId, "org:admin");

    const response = await accept(
      client().updateBot({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
        body: { defaultAgentId: otherOrgAgent.composeId },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    await expect(defaultComposeId(bot.botId)).resolves.toBe(bot.composeId);
  });

  it("returns 404 when the custom bot default agent is missing", async () => {
    const bot = await seedBot();
    mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:member");

    const response = await accept(
      client().updateBot({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
        body: { defaultAgentId: randomUUID() },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
  });

  it("updates the official bot agent preference for the current user and org", async () => {
    const orgId = newId("org");
    const userId = newId("user");
    const selectedAgent = await seedCompose({ orgId, userId });
    mocks.clerk.session(userId, orgId, "org:member");

    const response = await accept(
      client().updateBot({
        params: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
        body: { selectedAgentId: selectedAgent.composeId },
      }),
      [200],
    );

    expect(response.body.agent).toStrictEqual({
      id: selectedAgent.composeId,
      name: selectedAgent.name,
    });
    expect(response.body.official?.usesDefaultAgent).toBeFalsy();
    await expect(selectedPreference({ orgId, userId })).resolves.toBe(
      selectedAgent.composeId,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "telegram:changed",
      null,
    );
  });

  it("clears the official bot agent preference when selectedAgentId is null", async () => {
    const orgId = newId("org");
    const userId = newId("user");
    const selectedAgent = await seedCompose({ orgId, userId });
    await store.set(
      seedUserAgentPreference$,
      { orgId, userId, composeId: selectedAgent.composeId },
      context.signal,
    );
    mocks.clerk.session(userId, orgId, "org:member");

    const response = await accept(
      client().updateBot({
        params: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
        body: { selectedAgentId: null },
      }),
      [200],
    );

    expect(response.body.official?.usesDefaultAgent).toBeTruthy();
    await expect(selectedPreference({ orgId, userId })).resolves.toBeNull();
  });

  it("returns 400 when selectedAgentId is missing for the official bot", async () => {
    mocks.clerk.session(newId("user"), newId("org"), "org:member");

    const response = await accept(
      client().updateBot({
        params: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
        body: {},
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: { message: "selectedAgentId is required", code: "BAD_REQUEST" },
    });
  });

  it("returns 404 when the official bot selected agent is missing", async () => {
    mocks.clerk.session(newId("user"), newId("org"), "org:member");

    const response = await accept(
      client().updateBot({
        params: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
        body: { selectedAgentId: randomUUID() },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
  });

  it("returns 403 when the official bot selected agent belongs to another org", async () => {
    const orgId = newId("org");
    const userId = newId("user");
    const otherOrgAgent = await seedCompose({
      orgId: newId("org"),
      userId,
    });
    mocks.clerk.session(userId, orgId, "org:member");

    const response = await accept(
      client().updateBot({
        params: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
        body: { selectedAgentId: otherOrgAgent.composeId },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Telegram official bot preferences can only use agents in the active organization",
        code: "FORBIDDEN",
      },
    });
  });
});
