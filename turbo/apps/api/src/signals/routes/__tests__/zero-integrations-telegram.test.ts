import { randomUUID } from "node:crypto";

import { integrationsTelegramBotListContract } from "@vm0/api-contracts/contracts/integrations";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { mockEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import {
  deleteTelegramFixture$,
  freezeTelegramFixture,
  makeTelegramFixtureBuilder,
  seedTelegramInstallation$,
  type TelegramFixture,
} from "./helpers/zero-telegram";

const context = testContext();
const store = createStore();

const OFFICIAL_BOT_TOKEN = "9876543210:fake-test-token";
const OFFICIAL_BOT_USERNAME = "official_zero_bot";
const OFFICIAL_WEBHOOK_SECRET = "official-test-webhook-secret";

function configureOfficialBotEnv(): void {
  mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", OFFICIAL_BOT_TOKEN);
  mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", OFFICIAL_BOT_USERNAME);
  mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", OFFICIAL_WEBHOOK_SECRET);
}

function newTelegramBotId(): string {
  return String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000);
}

function mintZeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly "telegram:read"[];
}): string {
  const nowSeconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero" as const,
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: args.capabilities,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  });
}

async function seedMembership(orgId: string, userId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(orgMembersCache).values({
    orgId,
    userId,
    role: "member",
    cachedAt: new Date(now()),
  });
}

async function deleteMembership(orgId: string, userId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(orgMembersCache)
    .where(
      and(eq(orgMembersCache.orgId, orgId), eq(orgMembersCache.userId, userId)),
    );
}

describe("GET /api/zero/integrations/telegram/bots", () => {
  const fixtures: TelegramFixture[] = [];
  const memberships: { orgId: string; userId: string }[] = [];

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
    while (memberships.length > 0) {
      const membership = memberships.pop();
      if (membership) {
        await deleteMembership(membership.orgId, membership.userId);
      }
    }
  });

  it("returns 401 when no auth token is provided", async () => {
    const client = setupApp({ context })(integrationsTelegramBotListContract);

    const response = await accept(client.listBots({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("lists the official bot and custom Telegram bots in the active org", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const otherOrgId = `org_${randomUUID()}`;

    await seedMembership(orgId, userId);
    memberships.push({ orgId, userId });

    const ownerBotId = newTelegramBotId();
    const orgBotId = newTelegramBotId();
    const otherOrgBotId = newTelegramBotId();

    context.mocks.telegram.getMe.mockResolvedValue({
      id: 1,
      is_bot: true,
      first_name: "Bot",
      username: "x",
    });

    const builderA = makeTelegramFixtureBuilder(orgId);
    const builderB = makeTelegramFixtureBuilder(otherOrgId);

    const ownerInstall = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId: ownerBotId },
      context.signal,
    );
    builderA.composeIds.push(ownerInstall.composeId);
    builderA.telegramBotIds.push(ownerInstall.telegramBotId);

    const orgInstall = await store.set(
      seedTelegramInstallation$,
      {
        orgId,
        ownerUserId: `user_${randomUUID()}`,
        telegramBotId: orgBotId,
      },
      context.signal,
    );
    builderA.composeIds.push(orgInstall.composeId);
    builderA.telegramBotIds.push(orgInstall.telegramBotId);

    const otherOrgInstall = await store.set(
      seedTelegramInstallation$,
      {
        orgId: otherOrgId,
        ownerUserId: userId,
        telegramBotId: otherOrgBotId,
      },
      context.signal,
    );
    builderB.composeIds.push(otherOrgInstall.composeId);
    builderB.telegramBotIds.push(otherOrgInstall.telegramBotId);

    fixtures.push(freezeTelegramFixture(builderA));
    fixtures.push(freezeTelegramFixture(builderB));

    const token = mintZeroToken({
      userId,
      orgId,
      capabilities: ["telegram:read"],
    });
    const client = setupApp({ context })(integrationsTelegramBotListContract);

    const response = await accept(
      client.listBots({ headers: { authorization: `Bearer ${token}` } }),
      [200],
    );

    expect(response.body.bots).toHaveLength(3);
    expect(response.body.bots).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: OFFICIAL_TELEGRAM_BOT_ID,
          kind: "official",
        }),
        expect.objectContaining({ id: ownerBotId, isOwner: true }),
        expect.objectContaining({ id: orgBotId, isOwner: false }),
      ]),
    );
    expect(
      response.body.bots.some((bot) => {
        return bot.id === otherOrgBotId;
      }),
    ).toBeFalsy();
  });

  it("returns the official bot when the active org has no custom Telegram bots", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    await seedMembership(orgId, userId);
    memberships.push({ orgId, userId });

    const token = mintZeroToken({
      userId,
      orgId,
      capabilities: ["telegram:read"],
    });
    const client = setupApp({ context })(integrationsTelegramBotListContract);

    const response = await accept(
      client.listBots({ headers: { authorization: `Bearer ${token}` } }),
      [200],
    );

    expect(response.body.bots).toHaveLength(1);
    expect(response.body.bots[0]).toMatchObject({
      id: OFFICIAL_TELEGRAM_BOT_ID,
      kind: "official",
      isOwner: false,
      official: { linkedTelegramUserId: null },
    });
  });
});
