import { randomUUID } from "node:crypto";

import { OFFICIAL_TELEGRAM_BOT_ID } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { integrationsTelegramBotListContract } from "@vm0/api-contracts/contracts/integrations";
import { createStore } from "ccstate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import {
  deleteTelegramFixture$,
  freezeTelegramFixture,
  makeTelegramFixtureBuilder,
  seedOfficialUserLink$,
  seedOrgDefaultAgent$,
  seedTelegramInstallation$,
  seedTelegramUserLink$,
  seedUserAgentPreference$,
  type TelegramFixture,
} from "./helpers/zero-telegram";

// BDD migration of the legacy
// `zero-telegram-data.service.test.ts`. The 10 legacy
// `it()`s collapse into 3 BDD `it()`s: (1) official-bot +
// no-custom chain (200 returns only the official bot when
// org has zero custom installations → 200 prepends the
// official bot to a list of custom installations → 200
// marks a custom bot token invalid when getMe returns a
// different bot id), (2) env + agent-preference chain
// (200 returns the official bot with configured=false
// when env is unset → 200 uses the user's selected compose
// preference for the official bot agent → 200 falls back
// to the org's default agent when the user has no
// preference → 200 returns null agent when the org has no
// default and the user has no preference), (3) connection
// + cross-org chain (200 marks the official bot connected
// when the user has a telegram_official_user_links row
// → 200 marks the official bot disconnected when the
// user has no link row → 200 does not leak preferences or
// links from a different org).
//
// Service-Level Exception: This is a service test that
// exercises `zeroTelegramBots` (a Computed signal). It
// is migrated to test the route at
// `GET /api/zero/integrations/telegram/bots` which is the
// only consumer of the signal.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const OFFICIAL_BOT_TOKEN = "9876543210:fake-test-token";
const OFFICIAL_BOT_USERNAME = "official_zero_bot";
const OFFICIAL_WEBHOOK_SECRET = "official-test-webhook-secret";

function newOrgId(): string {
  return `org_${randomUUID()}`;
}

function newUserId(): string {
  return `user_${randomUUID()}`;
}

function newTelegramBotId(): string {
  return String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000);
}

function configureOfficialBotEnv(): void {
  mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", OFFICIAL_BOT_TOKEN);
  mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", OFFICIAL_BOT_USERNAME);
  mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", OFFICIAL_WEBHOOK_SECRET);
}

function createTelegramBotsHarness(): {
  readonly fixtures: TelegramFixture[];
  readonly track: (fixture: TelegramFixture) => void;
} {
  const fixtures: TelegramFixture[] = [];
  const track = (fixture: TelegramFixture) => {
    fixtures.push(fixture);
  };
  return { fixtures, track };
}

describe("BDD GET /api/zero/integrations/telegram/bots — official + custom chain", () => {
  const { fixtures, track } = createTelegramBotsHarness();

  beforeEach(() => {
    configureOfficialBotEnv();
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteTelegramFixture$, fixture, context.signal);
      }
    }
  });

  it("gwt-wt-wt: 200 returns only the official bot when org has zero custom installations → 200 prepends the official bot to a list of custom installations → 200 marks a custom bot token invalid when getMe returns a different bot id", async () => {
    // Given: a fresh org with no custom installations +
    // the official bot env.
    const orgId = newOrgId();
    const userId = newUserId();
    track(freezeTelegramFixture(makeTelegramFixtureBuilder(orgId)));
    mocks.clerk.session(userId, orgId);

    // When + Then: 200 — only the official bot is
    // returned.
    const emptyBots = await accept(
      setupApp({ context })(integrationsTelegramBotListContract).listBots({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(emptyBots.body.bots).toHaveLength(1);
    expect(emptyBots.body.bots[0]).toMatchObject({
      id: OFFICIAL_TELEGRAM_BOT_ID,
      kind: "official",
      isOwner: false,
      isConnected: false,
      tokenStatus: "valid",
      official: {
        configured: true,
        usesDefaultAgent: true,
        linkedTelegramUserId: null,
      },
    });
    expect(emptyBots.body.bots[0]?.username).toBe(OFFICIAL_BOT_USERNAME);

    // Given: a fresh org + a custom installation with
    // owner + a custom installation with a different
    // owner.
    const ownerOrgId = newOrgId();
    const ownerUserId = newUserId();
    const ownerBuilder = makeTelegramFixtureBuilder(ownerOrgId);
    ownerBuilder.userIds.push(ownerUserId);
    const ownerBotId = newTelegramBotId();
    const otherBotId = newTelegramBotId();

    context.mocks.telegram.getMe.mockResolvedValue({
      id: 1,
      is_bot: true,
      first_name: "Bot",
      username: "x",
    });

    const ownerInstall = await store.set(
      seedTelegramInstallation$,
      {
        orgId: ownerOrgId,
        ownerUserId,
        telegramBotId: ownerBotId,
        composeName: "compose-owned-agent",
        agentName: "zero-owned-agent",
      },
      context.signal,
    );
    ownerBuilder.composeIds.push(ownerInstall.composeId);
    ownerBuilder.telegramBotIds.push(ownerInstall.telegramBotId);

    await store.set(
      seedTelegramUserLink$,
      {
        installationId: ownerBotId,
        telegramUserId: "tg_owner",
        telegramUsername: "owner_tg",
        telegramDisplayName: "Owner User",
        vm0UserId: ownerUserId,
      },
      context.signal,
    );

    const otherInstall = await store.set(
      seedTelegramInstallation$,
      {
        orgId: ownerOrgId,
        ownerUserId: `user_${randomUUID()}`,
        telegramBotId: otherBotId,
      },
      context.signal,
    );
    ownerBuilder.composeIds.push(otherInstall.composeId);
    ownerBuilder.telegramBotIds.push(otherInstall.telegramBotId);

    track(freezeTelegramFixture(ownerBuilder));
    mocks.clerk.session(ownerUserId, ownerOrgId);

    // When + Then: 200 — 3 bots: official first, then
    // owner + other.
    const populatedResponse = await accept(
      setupApp({ context })(integrationsTelegramBotListContract).listBots({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(populatedResponse.body.bots).toHaveLength(3);
    expect(populatedResponse.body.bots[0]).toMatchObject({
      id: OFFICIAL_TELEGRAM_BOT_ID,
      kind: "official",
    });
    const customBotIds = populatedResponse.body.bots.slice(1).map((bot) => {
      return bot.id;
    });
    expect(customBotIds).toContain(ownerBotId);
    expect(customBotIds).toContain(otherBotId);
    const ownerBot = populatedResponse.body.bots.find((bot) => {
      return bot.id === ownerBotId;
    });
    expect(ownerBot?.isOwner).toBeTruthy();
    expect(ownerBot?.isConnected).toBeTruthy();
    expect(ownerBot?.agent).toStrictEqual({
      id: ownerInstall.composeId,
      name: "compose-owned-agent",
    });
    expect(ownerBot?.connectedUser).toStrictEqual({
      telegramUserId: "tg_owner",
      telegramUsername: "owner_tg",
      telegramDisplayName: "Owner User",
    });
    const otherBot = populatedResponse.body.bots.find((bot) => {
      return bot.id === otherBotId;
    });
    expect(otherBot?.isOwner).toBeFalsy();
    expect(otherBot?.isConnected).toBeFalsy();

    // Given: a custom installation where getMe returns a
    // different bot id.
    const invalidOrgId = newOrgId();
    const invalidUserId = newUserId();
    const invalidBuilder = makeTelegramFixtureBuilder(invalidOrgId);
    invalidBuilder.userIds.push(invalidUserId);
    const invalidBotId = newTelegramBotId();

    context.mocks.telegram.getMe.mockResolvedValue({
      id: Number(invalidBotId) + 1,
      is_bot: true,
      first_name: "Wrong Bot",
      username: "wrong_bot",
    });

    const invalidInstall = await store.set(
      seedTelegramInstallation$,
      {
        orgId: invalidOrgId,
        ownerUserId: invalidUserId,
        telegramBotId: invalidBotId,
      },
      context.signal,
    );
    invalidBuilder.composeIds.push(invalidInstall.composeId);
    invalidBuilder.telegramBotIds.push(invalidInstall.telegramBotId);
    track(freezeTelegramFixture(invalidBuilder));
    mocks.clerk.session(invalidUserId, invalidOrgId);

    // When + Then: 200 — the custom bot is marked
    // `tokenStatus: invalid`.
    const invalidResponse = await accept(
      setupApp({ context })(integrationsTelegramBotListContract).listBots({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const customBot = invalidResponse.body.bots.find((bot) => {
      return bot.id === invalidBotId;
    });
    expect(customBot?.tokenStatus).toBe("invalid");
  });
});

describe("BDD GET /api/zero/integrations/telegram/bots — env + agent-preference chain", () => {
  const { fixtures, track } = createTelegramBotsHarness();

  beforeEach(() => {
    configureOfficialBotEnv();
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteTelegramFixture$, fixture, context.signal);
      }
    }
  });

  it("gwt-wt-wt: 200 returns the official bot with configured=false when env is unset → 200 uses the user's selected compose preference for the official bot agent → 200 falls back to the org's default agent when the user has no preference → 200 returns null agent when the org has no default and the user has no preference", async () => {
    // Given: the official bot env is unset.
    mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", undefined);
    mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", undefined);
    mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", undefined);

    const unsetOrgId = newOrgId();
    const unsetUserId = newUserId();
    track(freezeTelegramFixture(makeTelegramFixtureBuilder(unsetOrgId)));
    mocks.clerk.session(unsetUserId, unsetOrgId);

    // When + Then: 200 — official bot has
    // `configured: false` + `username: null` +
    // `tokenStatus: unknown`.
    const unsetResponse = await accept(
      setupApp({ context })(integrationsTelegramBotListContract).listBots({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(unsetResponse.body.bots).toHaveLength(1);
    expect(unsetResponse.body.bots[0]).toMatchObject({
      id: OFFICIAL_TELEGRAM_BOT_ID,
      kind: "official",
      username: null,
      tokenStatus: "unknown",
      official: { configured: false },
    });

    // Restore env for the next sub-steps.
    configureOfficialBotEnv();

    // Given: a user-selected compose preference for the
    // official bot.
    const prefOrgId = newOrgId();
    const prefUserId = newUserId();
    const prefBuilder = makeTelegramFixtureBuilder(prefOrgId);
    prefBuilder.userIds.push(prefUserId);
    const preferred = await store.set(
      seedOrgDefaultAgent$,
      { orgId: prefOrgId, userId: prefUserId, composeName: "preferred-agent" },
      context.signal,
    );
    prefBuilder.composeIds.push(preferred.composeId);
    await store.set(
      seedUserAgentPreference$,
      { orgId: prefOrgId, userId: prefUserId, composeId: preferred.composeId },
      context.signal,
    );
    track(freezeTelegramFixture(prefBuilder));
    mocks.clerk.session(prefUserId, prefOrgId);

    // When + Then: 200 — the official bot uses the
    // user's preferred compose + `usesDefaultAgent` is
    // false.
    const prefResponse = await accept(
      setupApp({ context })(integrationsTelegramBotListContract).listBots({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(prefResponse.body.bots[0]?.agent).toStrictEqual({
      id: preferred.composeId,
      name: "preferred-agent",
    });
    expect(prefResponse.body.bots[0]?.official?.usesDefaultAgent).toBeFalsy();

    // Given: an org-default agent but no user preference.
    const defaultOrgId = newOrgId();
    const defaultUserId = newUserId();
    const defaultBuilder = makeTelegramFixtureBuilder(defaultOrgId);
    defaultBuilder.userIds.push(defaultUserId);
    const defaultAgent = await store.set(
      seedOrgDefaultAgent$,
      {
        orgId: defaultOrgId,
        userId: defaultUserId,
        composeName: "default-agent",
      },
      context.signal,
    );
    defaultBuilder.composeIds.push(defaultAgent.composeId);
    track(freezeTelegramFixture(defaultBuilder));
    mocks.clerk.session(defaultUserId, defaultOrgId);

    // When + Then: 200 — falls back to the org's default
    // agent + `usesDefaultAgent` is true.
    const defaultResponse = await accept(
      setupApp({ context })(integrationsTelegramBotListContract).listBots({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(defaultResponse.body.bots[0]?.agent).toStrictEqual({
      id: defaultAgent.composeId,
      name: "default-agent",
    });
    expect(
      defaultResponse.body.bots[0]?.official?.usesDefaultAgent,
    ).toBeTruthy();

    // Given: a fresh org with no default + no preference.
    const nullAgentOrgId = newOrgId();
    const nullAgentUserId = newUserId();
    track(freezeTelegramFixture(makeTelegramFixtureBuilder(nullAgentOrgId)));
    mocks.clerk.session(nullAgentUserId, nullAgentOrgId);

    // When + Then: 200 — agent is null + `usesDefaultAgent`
    // is true.
    const nullAgentResponse = await accept(
      setupApp({ context })(integrationsTelegramBotListContract).listBots({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(nullAgentResponse.body.bots[0]?.agent).toBeNull();
    expect(
      nullAgentResponse.body.bots[0]?.official?.usesDefaultAgent,
    ).toBeTruthy();
  });
});

describe("BDD GET /api/zero/integrations/telegram/bots — connection + cross-org chain", () => {
  const { fixtures, track } = createTelegramBotsHarness();

  beforeEach(() => {
    configureOfficialBotEnv();
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteTelegramFixture$, fixture, context.signal);
      }
    }
  });

  it("gwt-wt-wt: 200 marks the official bot connected when the user has a telegram_official_user_links row → 200 marks the official bot disconnected when the user has no link row → 200 does not leak preferences or links from a different org", async () => {
    // Given: a user with a telegram_official_user_links
    // row.
    const connectedOrgId = newOrgId();
    const connectedUserId = newUserId();
    const telegramUserId = `tg_${randomUUID()}`;
    const connectedBuilder = makeTelegramFixtureBuilder(connectedOrgId);
    connectedBuilder.userIds.push(connectedUserId);
    await store.set(
      seedOfficialUserLink$,
      {
        orgId: connectedOrgId,
        userId: connectedUserId,
        telegramUserId,
        telegramUsername: "ada_tg",
        telegramDisplayName: "Ada Lovelace",
      },
      context.signal,
    );
    track(freezeTelegramFixture(connectedBuilder));
    mocks.clerk.session(connectedUserId, connectedOrgId);

    // When + Then: 200 — official bot is connected +
    // linkedTelegramUserId + connectedUser is populated.
    const connectedResponse = await accept(
      setupApp({ context })(integrationsTelegramBotListContract).listBots({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(connectedResponse.body.bots[0]?.isConnected).toBeTruthy();
    expect(connectedResponse.body.bots[0]?.official?.linkedTelegramUserId).toBe(
      telegramUserId,
    );
    expect(connectedResponse.body.bots[0]?.connectedUser).toStrictEqual({
      telegramUserId,
      telegramUsername: "ada_tg",
      telegramDisplayName: "Ada Lovelace",
    });

    // Given: a fresh org with no link row.
    const disconnectedOrgId = newOrgId();
    const disconnectedUserId = newUserId();
    track(freezeTelegramFixture(makeTelegramFixtureBuilder(disconnectedOrgId)));
    mocks.clerk.session(disconnectedUserId, disconnectedOrgId);

    // When + Then: 200 — official bot is disconnected +
    // linkedTelegramUserId is null.
    const disconnectedResponse = await accept(
      setupApp({ context })(integrationsTelegramBotListContract).listBots({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(disconnectedResponse.body.bots[0]?.isConnected).toBeFalsy();
    expect(
      disconnectedResponse.body.bots[0]?.official?.linkedTelegramUserId,
    ).toBeNull();

    // Given: a fresh org with cross-org link + preference
    // (must NOT appear in this org's response).
    const isolatedOrgId = newOrgId();
    const isolatedUserId = newUserId();
    const isolatedBuilder = makeTelegramFixtureBuilder(isolatedOrgId);
    isolatedBuilder.userIds.push(isolatedUserId);
    const otherOrgId = newOrgId();
    await store.set(
      seedOfficialUserLink$,
      {
        orgId: otherOrgId,
        userId: isolatedUserId,
        telegramUserId: `tg_${randomUUID()}`,
      },
      context.signal,
    );
    const otherCompose = await store.set(
      seedOrgDefaultAgent$,
      {
        orgId: otherOrgId,
        userId: isolatedUserId,
        composeName: "other-org-agent",
      },
      context.signal,
    );
    await store.set(
      seedUserAgentPreference$,
      {
        orgId: otherOrgId,
        userId: isolatedUserId,
        composeId: otherCompose.composeId,
      },
      context.signal,
    );
    const otherBuilder = makeTelegramFixtureBuilder(otherOrgId);
    otherBuilder.composeIds.push(otherCompose.composeId);
    track(freezeTelegramFixture(otherBuilder));
    track(freezeTelegramFixture(isolatedBuilder));
    mocks.clerk.session(isolatedUserId, isolatedOrgId);

    // When + Then: 200 — official bot is disconnected +
    // agent is null (no cross-org leak).
    const isolatedResponse = await accept(
      setupApp({ context })(integrationsTelegramBotListContract).listBots({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(isolatedResponse.body.bots[0]?.isConnected).toBeFalsy();
    expect(
      isolatedResponse.body.bots[0]?.official?.linkedTelegramUserId,
    ).toBeNull();
    expect(isolatedResponse.body.bots[0]?.agent).toBeNull();
  });
});
