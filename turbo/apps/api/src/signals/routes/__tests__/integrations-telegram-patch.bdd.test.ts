import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramUserAgentPreferences } from "@vm0/db/schema/telegram-user-agent-preference";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import {
  OFFICIAL_TELEGRAM_BOT_ID,
  zeroIntegrationsTelegramContract,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { beforeEach, describe, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import {
  deleteTelegramFixture$,
  seedTelegramInstallation$,
  seedUserAgentPreference$,
  type TelegramFixture,
} from "./helpers/zero-telegram";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy
// `integrations-telegram-patch.test.ts`. The 13 legacy
// `it()`s collapse into 2 BDD `it()`s:
// (1) auth + custom-bot update chain (401 unauth → 400
// missing defaultAgentId → 403 non-admin non-owner → 200
// admin update with isOwner=false + ably publish → 200
// owner update with isOwner=true → 403 defaultAgentId in
// another org → 404 bot invisible in active org → 404
// missing default agent),
// (2) official-bot preference chain (200 user selects
// preferred agent with usesDefaultAgent=false + ably
// publish → 200 selectedAgentId=null clears back to
// default → 400 missing selectedAgentId → 404 missing
// selected agent → 403 selected agent in another org).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const AUTH_HEADERS = { authorization: "Bearer clerk-session" } as const;

interface SeededBot {
  readonly botId: string;
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly composeId: string;
  readonly fixture: TelegramFixture;
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function newTelegramBotId(): string {
  return String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000);
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

function client() {
  return setupApp({ context })(zeroIntegrationsTelegramContract);
}

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
  context.mocks.ably.publish.mockClear();
});

describe("BDD PATCH /api/integrations/telegram/:botId — auth + custom-bot update chain", () => {
  const track = createFixtureTracker<TelegramFixture>((fixture) => {
    return store.set(deleteTelegramFixture$, fixture, context.signal);
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
    const botId = args.botId ?? newTelegramBotId();
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId, telegramBotId: botId },
      context.signal,
    );
    const baseFixture: TelegramFixture = {
      orgId,
      composeIds: [installation.composeId],
      telegramBotIds: [botId],
      userIds: [ownerUserId],
    };
    const fixture = await track(Promise.resolve(baseFixture));
    return {
      botId,
      orgId,
      ownerUserId,
      composeId: installation.composeId,
      fixture,
    };
  }

  async function seedCompose(
    orgId: string,
    userId: string,
    name?: string,
  ): Promise<{ readonly composeId: string; readonly name: string }> {
    const composeId = randomUUID();
    const composedName = name ?? newId("agent");
    const writeDb = store.set(writeDb$);

    await writeDb.insert(agentComposes).values({
      id: composeId,
      userId,
      orgId,
      name: composedName,
    });
    await writeDb.insert(zeroAgents).values({
      id: composeId,
      orgId,
      owner: userId,
      name: composedName,
    });

    await track(
      Promise.resolve({
        orgId,
        composeIds: [composeId],
        telegramBotIds: [],
        userIds: [userId],
      }),
    );

    return { composeId, name: composedName };
  }

  it("gwt-wt-wt: 401 unauth → 400 missing defaultAgentId → 403 non-admin non-owner → 200 admin update isOwner=false + ably publish → 200 owner update isOwner=true → 403 defaultAgentId in another org → 404 bot invisible in active org → 404 missing default agent", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      client().updateBot({
        params: { botId: newTelegramBotId() },
        headers: {},
        body: { defaultAgentId: newId("agent") },
      }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a seeded bot + a member session with an
    // empty body.

    // When + Then: 400 — defaultAgentId is required.
    const missingBodyBot = await seedBot();
    mocks.clerk.session(
      missingBodyBot.ownerUserId,
      missingBodyBot.orgId,
      "org:member",
    );
    const missingBodyResponse = await accept(
      client().updateBot({
        params: { botId: missingBodyBot.botId },
        headers: AUTH_HEADERS,
        body: {},
      }),
      [400],
    );
    expect(missingBodyResponse.body).toStrictEqual({
      error: { message: "defaultAgentId is required", code: "BAD_REQUEST" },
    });

    // Given: a seeded bot owned by someone else + a
    // non-admin member session.

    // When + Then: 403 — only the bot owner or an org
    // admin can change the default agent.
    const nonAdminBot = await seedBot({ ownerUserId: newId("owner") });
    mocks.clerk.session(newId("member"), nonAdminBot.orgId, "org:member");
    const nonAdminResponse = await accept(
      client().updateBot({
        params: { botId: nonAdminBot.botId },
        headers: AUTH_HEADERS,
        body: { defaultAgentId: nonAdminBot.composeId },
      }),
      [403],
    );
    expect(nonAdminResponse.body).toStrictEqual({
      error: {
        message:
          "Only the bot owner or an org admin can change the default agent",
        code: "FORBIDDEN",
      },
    });

    // Given: a seeded bot + a new compose in the same
    // org + an admin session.

    // When + Then: 200 — agent reflects the new compose
    // + isOwner is false for the admin + the DB row
    // is updated + the ably channel publishes.
    const adminBot = await seedBot({ ownerUserId: newId("owner") });
    const adminUserId = newId("admin");
    const nextAdminAgent = await seedCompose(adminBot.orgId, adminUserId);
    mocks.clerk.session(adminUserId, adminBot.orgId, "org:admin");
    const adminResponse = await accept(
      client().updateBot({
        params: { botId: adminBot.botId },
        headers: AUTH_HEADERS,
        body: { defaultAgentId: nextAdminAgent.composeId },
      }),
      [200],
    );
    expect(adminResponse.body.agent).toStrictEqual({
      id: nextAdminAgent.composeId,
      name: nextAdminAgent.name,
    });
    expect(adminResponse.body.id).toBe(adminBot.botId);
    expect(adminResponse.body.isOwner).toBeFalsy();
    await expect(defaultComposeId(adminBot.botId)).resolves.toBe(
      nextAdminAgent.composeId,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "telegram:changed",
      null,
    );

    // Given: a seeded bot + a new compose owned by the
    // bot owner + the owner session.

    // When + Then: 200 — agent reflects the new compose
    // + isOwner is true.
    const ownerBot = await seedBot();
    const nextOwnerAgent = await seedCompose(
      ownerBot.orgId,
      ownerBot.ownerUserId,
    );
    mocks.clerk.session(ownerBot.ownerUserId, ownerBot.orgId, "org:member");
    const ownerResponse = await accept(
      client().updateBot({
        params: { botId: ownerBot.botId },
        headers: AUTH_HEADERS,
        body: { defaultAgentId: nextOwnerAgent.composeId },
      }),
      [200],
    );
    expect(ownerResponse.body.agent).toStrictEqual({
      id: nextOwnerAgent.composeId,
      name: nextOwnerAgent.name,
    });
    expect(ownerResponse.body.isOwner).toBeTruthy();
    await expect(defaultComposeId(ownerBot.botId)).resolves.toBe(
      nextOwnerAgent.composeId,
    );

    // Given: a seeded bot + a compose in a different
    // org + the bot owner session.

    // When + Then: 403 — agents must live in the bot's
    // organization.
    const crossOrgBot = await seedBot();
    const crossOrgAgent = await seedCompose(
      newId("org"),
      crossOrgBot.ownerUserId,
    );
    mocks.clerk.session(
      crossOrgBot.ownerUserId,
      crossOrgBot.orgId,
      "org:member",
    );
    const crossOrgResponse = await accept(
      client().updateBot({
        params: { botId: crossOrgBot.botId },
        headers: AUTH_HEADERS,
        body: { defaultAgentId: crossOrgAgent.composeId },
      }),
      [403],
    );
    expect(crossOrgResponse.body).toStrictEqual({
      error: {
        message:
          "Telegram bots can only be connected to agents in the bot's organization",
        code: "FORBIDDEN",
      },
    });

    // Given: a seeded bot + a compose in another org +
    // an admin session in that other org.

    // When + Then: 404 — the bot is invisible in the
    // active org + the defaultComposeId is unchanged.
    const invisibleBot = await seedBot();
    const otherOrgId = newId("org");
    const otherOrgAgent = await seedCompose(
      otherOrgId,
      invisibleBot.ownerUserId,
    );
    mocks.clerk.session(invisibleBot.ownerUserId, otherOrgId, "org:admin");
    const invisibleResponse = await accept(
      client().updateBot({
        params: { botId: invisibleBot.botId },
        headers: AUTH_HEADERS,
        body: { defaultAgentId: otherOrgAgent.composeId },
      }),
      [404],
    );
    expect(invisibleResponse.body.error.code).toBe("NOT_FOUND");
    await expect(defaultComposeId(invisibleBot.botId)).resolves.toBe(
      invisibleBot.composeId,
    );

    // Given: a seeded bot + the bot owner session + a
    // random non-existent agent id.

    // When + Then: 404 — agent not found.
    const missingAgentBot = await seedBot();
    mocks.clerk.session(
      missingAgentBot.ownerUserId,
      missingAgentBot.orgId,
      "org:member",
    );
    const missingAgentResponse = await accept(
      client().updateBot({
        params: { botId: missingAgentBot.botId },
        headers: AUTH_HEADERS,
        body: { defaultAgentId: randomUUID() },
      }),
      [404],
    );
    expect(missingAgentResponse.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
  });
});

describe("BDD PATCH /api/integrations/telegram/:botId — official-bot preference chain", () => {
  const track = createFixtureTracker<TelegramFixture>((fixture) => {
    return store.set(deleteTelegramFixture$, fixture, context.signal);
  });

  async function seedCompose(
    orgId: string,
    userId: string,
  ): Promise<{ readonly composeId: string; readonly name: string }> {
    const composeId = randomUUID();
    const name = newId("agent");
    const writeDb = store.set(writeDb$);

    await writeDb.insert(agentComposes).values({
      id: composeId,
      userId,
      orgId,
      name,
    });
    await writeDb.insert(zeroAgents).values({
      id: composeId,
      orgId,
      owner: userId,
      name,
    });

    await track(
      Promise.resolve({
        orgId,
        composeIds: [composeId],
        telegramBotIds: [],
        userIds: [userId],
      }),
    );

    return { composeId, name };
  }

  it("gwt-wt-wt: 200 user selects preferred agent usesDefaultAgent=false + ably publish → 200 selectedAgentId=null clears back to default → 400 missing selectedAgentId → 404 missing selected agent → 403 selected agent in another org", async () => {
    // Given: an org + a user + a seeded compose in the
    // org.

    // When + Then: 200 — agent reflects the selected
    // compose + usesDefaultAgent is false + the
    // selectedComposeId is persisted + ably publishes.
    const selectOrgId = newId("org");
    const selectUserId = newId("user");
    const selectedAgent = await seedCompose(selectOrgId, selectUserId);
    mocks.clerk.session(selectUserId, selectOrgId, "org:member");
    const selectResponse = await accept(
      client().updateBot({
        params: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
        body: { selectedAgentId: selectedAgent.composeId },
      }),
      [200],
    );
    expect(selectResponse.body.agent).toStrictEqual({
      id: selectedAgent.composeId,
      name: selectedAgent.name,
    });
    expect(selectResponse.body.official?.usesDefaultAgent).toBeFalsy();
    await expect(
      selectedPreference({ orgId: selectOrgId, userId: selectUserId }),
    ).resolves.toBe(selectedAgent.composeId);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "telegram:changed",
      null,
    );

    // Given: an org + a user + a seeded compose + an
    // existing selectedComposeId preference.

    // When + Then: 200 — usesDefaultAgent flips back to
    // true + the persisted preference is cleared.
    const clearOrgId = newId("org");
    const clearUserId = newId("user");
    const clearAgent = await seedCompose(clearOrgId, clearUserId);
    await store.set(
      seedUserAgentPreference$,
      {
        orgId: clearOrgId,
        userId: clearUserId,
        composeId: clearAgent.composeId,
      },
      context.signal,
    );
    mocks.clerk.session(clearUserId, clearOrgId, "org:member");
    const clearResponse = await accept(
      client().updateBot({
        params: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
        body: { selectedAgentId: null },
      }),
      [200],
    );
    expect(clearResponse.body.official?.usesDefaultAgent).toBeTruthy();
    await expect(
      selectedPreference({ orgId: clearOrgId, userId: clearUserId }),
    ).resolves.toBeNull();

    // Given: a fresh user/org session with an empty
    // body for the official bot.

    // When + Then: 400 — selectedAgentId is required.
    mocks.clerk.session(newId("user"), newId("org"), "org:member");
    const missingResponse = await accept(
      client().updateBot({
        params: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
        body: {},
      }),
      [400],
    );
    expect(missingResponse.body).toStrictEqual({
      error: { message: "selectedAgentId is required", code: "BAD_REQUEST" },
    });

    // Given: a fresh user/org session + a random
    // non-existent selectedAgentId.

    // When + Then: 404 — agent not found.
    mocks.clerk.session(newId("user"), newId("org"), "org:member");
    const missingAgentResponse = await accept(
      client().updateBot({
        params: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
        body: { selectedAgentId: randomUUID() },
      }),
      [404],
    );
    expect(missingAgentResponse.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });

    // Given: a user in org A + a compose in org B.

    // When + Then: 403 — official bot preferences are
    // restricted to the active organization.
    const officialCrossOrgId = newId("org");
    const officialCrossOrgUserId = newId("user");
    const officialCrossOrgAgent = await seedCompose(
      newId("org"),
      officialCrossOrgUserId,
    );
    mocks.clerk.session(
      officialCrossOrgUserId,
      officialCrossOrgId,
      "org:member",
    );
    const officialCrossOrgResponse = await accept(
      client().updateBot({
        params: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
        body: { selectedAgentId: officialCrossOrgAgent.composeId },
      }),
      [403],
    );
    expect(officialCrossOrgResponse.body).toStrictEqual({
      error: {
        message:
          "Telegram official bot preferences can only use agents in the active organization",
        code: "FORBIDDEN",
      },
    });
  });
});
