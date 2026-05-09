import { randomUUID } from "node:crypto";

import { OFFICIAL_TELEGRAM_BOT_ID } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { createStore } from "ccstate";
import { afterEach, beforeEach } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { zeroTelegramBots } from "../../services/zero-telegram-data.service";
import {
  deleteTelegramFixture$,
  freezeTelegramFixture,
  makeTelegramFixtureBuilder,
  seedOfficialUserLink$,
  seedOrgDefaultAgent$,
  seedTelegramInstallation$,
  seedUserAgentPreference$,
  type TelegramFixture,
} from "./helpers/zero-telegram";

const context = testContext();
const store = createStore();

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

describe("zeroTelegramBots service", () => {
  const fixtures: TelegramFixture[] = [];

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

  function trackFixture(fixture: TelegramFixture): void {
    fixtures.push(fixture);
  }

  it("returns only the official bot when org has zero custom installations", async () => {
    const orgId = newOrgId();
    const userId = newUserId();
    trackFixture(freezeTelegramFixture(makeTelegramFixtureBuilder(orgId)));

    const bots = await store.get(zeroTelegramBots({ orgId, userId }));

    expect(bots).toHaveLength(1);
    expect(bots[0]).toMatchObject({
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
    expect(bots[0]?.username).toBe(OFFICIAL_BOT_USERNAME);
  });

  it("prepends the official bot to a list of custom installations", async () => {
    const orgId = newOrgId();
    const userId = newUserId();
    const builder = makeTelegramFixtureBuilder(orgId);
    builder.userIds.push(userId);

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
        orgId,
        ownerUserId: userId,
        telegramBotId: ownerBotId,
      },
      context.signal,
    );
    builder.composeIds.push(ownerInstall.composeId);
    builder.telegramBotIds.push(ownerInstall.telegramBotId);

    const otherInstall = await store.set(
      seedTelegramInstallation$,
      {
        orgId,
        ownerUserId: `user_${randomUUID()}`,
        telegramBotId: otherBotId,
      },
      context.signal,
    );
    builder.composeIds.push(otherInstall.composeId);
    builder.telegramBotIds.push(otherInstall.telegramBotId);

    trackFixture(freezeTelegramFixture(builder));

    const bots = await store.get(zeroTelegramBots({ orgId, userId }));

    expect(bots).toHaveLength(3);
    expect(bots[0]).toMatchObject({
      id: OFFICIAL_TELEGRAM_BOT_ID,
      kind: "official",
    });
    const customBotIds = bots.slice(1).map((bot) => {
      return bot.id;
    });
    expect(customBotIds).toContain(ownerBotId);
    expect(customBotIds).toContain(otherBotId);
    const ownerBot = bots.find((bot) => {
      return bot.id === ownerBotId;
    });
    expect(ownerBot?.isOwner).toBeTruthy();
    const otherBot = bots.find((bot) => {
      return bot.id === otherBotId;
    });
    expect(otherBot?.isOwner).toBeFalsy();
  });

  it("returns the official bot with configured=false when env is unset", async () => {
    mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", undefined);
    mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", undefined);
    mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", undefined);

    const orgId = newOrgId();
    const userId = newUserId();
    trackFixture(freezeTelegramFixture(makeTelegramFixtureBuilder(orgId)));

    const bots = await store.get(zeroTelegramBots({ orgId, userId }));

    expect(bots).toHaveLength(1);
    expect(bots[0]).toMatchObject({
      id: OFFICIAL_TELEGRAM_BOT_ID,
      kind: "official",
      username: null,
      tokenStatus: "unknown",
      official: { configured: false },
    });
    expect(bots[0]?.avatarUrl).toBe("");
  });

  it("uses the user's selected compose preference for the official bot agent", async () => {
    const orgId = newOrgId();
    const userId = newUserId();
    const builder = makeTelegramFixtureBuilder(orgId);
    builder.userIds.push(userId);

    const preferred = await store.set(
      seedOrgDefaultAgent$,
      { orgId, userId, composeName: "preferred-agent" },
      context.signal,
    );
    builder.composeIds.push(preferred.composeId);

    await store.set(
      seedUserAgentPreference$,
      { orgId, userId, composeId: preferred.composeId },
      context.signal,
    );

    trackFixture(freezeTelegramFixture(builder));

    const bots = await store.get(zeroTelegramBots({ orgId, userId }));

    expect(bots[0]?.agent).toStrictEqual({
      id: preferred.composeId,
      name: "preferred-agent",
    });
    expect(bots[0]?.official?.usesDefaultAgent).toBeFalsy();
  });

  it("falls back to the org's default agent when the user has no preference", async () => {
    const orgId = newOrgId();
    const userId = newUserId();
    const builder = makeTelegramFixtureBuilder(orgId);
    builder.userIds.push(userId);

    const defaultAgent = await store.set(
      seedOrgDefaultAgent$,
      { orgId, userId, composeName: "default-agent" },
      context.signal,
    );
    builder.composeIds.push(defaultAgent.composeId);

    trackFixture(freezeTelegramFixture(builder));

    const bots = await store.get(zeroTelegramBots({ orgId, userId }));

    expect(bots[0]?.agent).toStrictEqual({
      id: defaultAgent.composeId,
      name: "default-agent",
    });
    expect(bots[0]?.official?.usesDefaultAgent).toBeTruthy();
  });

  it("returns null agent when the org has no default and the user has no preference", async () => {
    const orgId = newOrgId();
    const userId = newUserId();
    trackFixture(freezeTelegramFixture(makeTelegramFixtureBuilder(orgId)));

    const bots = await store.get(zeroTelegramBots({ orgId, userId }));

    expect(bots[0]?.agent).toBeNull();
    expect(bots[0]?.official?.usesDefaultAgent).toBeTruthy();
  });

  it("marks the official bot connected when the user has a telegram_official_user_links row", async () => {
    const orgId = newOrgId();
    const userId = newUserId();
    const telegramUserId = `tg_${randomUUID()}`;
    const builder = makeTelegramFixtureBuilder(orgId);
    builder.userIds.push(userId);

    await store.set(
      seedOfficialUserLink$,
      { orgId, userId, telegramUserId },
      context.signal,
    );

    trackFixture(freezeTelegramFixture(builder));

    const bots = await store.get(zeroTelegramBots({ orgId, userId }));

    expect(bots[0]?.isConnected).toBeTruthy();
    expect(bots[0]?.official?.linkedTelegramUserId).toBe(telegramUserId);
  });

  it("marks the official bot disconnected when the user has no link row", async () => {
    const orgId = newOrgId();
    const userId = newUserId();
    trackFixture(freezeTelegramFixture(makeTelegramFixtureBuilder(orgId)));

    const bots = await store.get(zeroTelegramBots({ orgId, userId }));

    expect(bots[0]?.isConnected).toBeFalsy();
    expect(bots[0]?.official?.linkedTelegramUserId).toBeNull();
  });

  it("does not leak preferences or links from a different org", async () => {
    const orgId = newOrgId();
    const userId = newUserId();
    const otherOrgId = newOrgId();
    const builder = makeTelegramFixtureBuilder(orgId);
    builder.userIds.push(userId);

    // Cross-org link and preference (must NOT appear in this org's response).
    await store.set(
      seedOfficialUserLink$,
      {
        orgId: otherOrgId,
        userId,
        telegramUserId: `tg_${randomUUID()}`,
      },
      context.signal,
    );
    const otherCompose = await store.set(
      seedOrgDefaultAgent$,
      { orgId: otherOrgId, userId, composeName: "other-org-agent" },
      context.signal,
    );
    await store.set(
      seedUserAgentPreference$,
      {
        orgId: otherOrgId,
        userId,
        composeId: otherCompose.composeId,
      },
      context.signal,
    );

    // Track the cross-org rows for cleanup via a separate fixture.
    const otherBuilder = makeTelegramFixtureBuilder(otherOrgId);
    otherBuilder.composeIds.push(otherCompose.composeId);
    trackFixture(freezeTelegramFixture(otherBuilder));
    trackFixture(freezeTelegramFixture(builder));

    const bots = await store.get(zeroTelegramBots({ orgId, userId }));

    expect(bots[0]?.isConnected).toBeFalsy();
    expect(bots[0]?.official?.linkedTelegramUserId).toBeNull();
    expect(bots[0]?.agent).toBeNull();
  });
});
