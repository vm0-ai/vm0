import { randomUUID } from "node:crypto";

import { integrationsTelegramBotListContract } from "@vm0/api-contracts/contracts/integrations";
import {
  OFFICIAL_TELEGRAM_BOT_ID,
  zeroIntegrationsTelegramContract,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { createStore } from "ccstate";
import { afterEach, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { mockEnv } from "../../../lib/env";
import { now } from "../../external/time";
import { buildTelegramBotAvatarUrl } from "../../external/telegram-avatar";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import {
  deleteTelegramFixture$,
  freezeTelegramFixture,
  makeTelegramFixtureBuilder,
  seedTelegramInstallation$,
  seedTelegramUserLink$,
  type TelegramFixture,
} from "./helpers/zero-telegram";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

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

function expectUnauthorized(body: unknown): void {
  expect(body).toStrictEqual({
    error: {
      message: "Not authenticated",
      code: "UNAUTHORIZED",
    },
  });
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

function telegramOauthHead(contentLength: string, expectedOrigin?: string) {
  return http.head("https://oauth.telegram.org/auth", ({ request }) => {
    const url = new URL(request.url);
    if (expectedOrigin) {
      expect(url.searchParams.get("origin")).toBe(expectedOrigin);
    }
    return new HttpResponse(null, {
      headers: { "content-length": contentLength },
    });
  });
}

describe("GET /api/zero/integrations/telegram/bots", () => {
  const fixtures: TelegramFixture[] = [];
  const memberships: OrgMembershipFixture[] = [];

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
        await store.set(deleteOrgMembership$, membership, context.signal);
      }
    }
  });

  it("returns 401 when no auth token is provided", async () => {
    const client = setupApp({ context })(integrationsTelegramBotListContract);

    const response = await accept(client.listBots({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const client = setupApp({ context })(integrationsTelegramBotListContract);

    const response = await accept(
      client.listBots({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expectUnauthorized(response.body);
  });

  it("lists the official bot and custom Telegram bots in the active org", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const otherOrgId = `org_${randomUUID()}`;

    const membership = await store.set(
      seedOrgMembership$,
      { orgId, userId, seedOrgCache: false },
      context.signal,
    );
    memberships.push(membership);

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

    const membership = await store.set(
      seedOrgMembership$,
      { orgId, userId, seedOrgCache: false },
      context.signal,
    );
    memberships.push(membership);

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

describe("GET /api/integrations/telegram", () => {
  const fixtures: TelegramFixture[] = [];
  const memberships: OrgMembershipFixture[] = [];

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
        await store.set(deleteOrgMembership$, membership, context.signal);
      }
    }
  });

  it("returns 401 when no auth token is provided", async () => {
    const client = setupApp({ context })(zeroIntegrationsTelegramContract);

    const response = await accept(client.list({ headers: {} }), [401]);

    expectUnauthorized(response.body);
  });

  it("lists official and active-org custom bots with link status", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const otherOrgId = `org_${randomUUID()}`;

    const membership = await store.set(
      seedOrgMembership$,
      { orgId, userId, seedOrgCache: false },
      context.signal,
    );
    memberships.push(membership);

    const linkedBotId = newTelegramBotId();
    const unlinkedBotId = newTelegramBotId();
    const otherOrgBotId = newTelegramBotId();

    context.mocks.telegram.getMe.mockImplementation((token: unknown) => {
      const botId =
        token === "test-bot-token"
          ? linkedBotId
          : String(token).split(":", 1)[0];
      return Promise.resolve({
        id: Number(botId),
        is_bot: true,
        first_name: "Bot",
        username: "x",
      });
    });

    const builderA = makeTelegramFixtureBuilder(orgId);
    const builderB = makeTelegramFixtureBuilder(otherOrgId);

    const linkedInstall = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId: linkedBotId },
      context.signal,
    );
    builderA.composeIds.push(linkedInstall.composeId);
    builderA.telegramBotIds.push(linkedInstall.telegramBotId);
    await store.set(
      seedTelegramUserLink$,
      {
        installationId: linkedInstall.telegramBotId,
        telegramUserId: "tg-linked-user",
        vm0UserId: userId,
      },
      context.signal,
    );

    const unlinkedInstall = await store.set(
      seedTelegramInstallation$,
      {
        orgId,
        ownerUserId: `user_${randomUUID()}`,
        telegramBotId: unlinkedBotId,
      },
      context.signal,
    );
    builderA.composeIds.push(unlinkedInstall.composeId);
    builderA.telegramBotIds.push(unlinkedInstall.telegramBotId);

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
    const client = setupApp({ context })(zeroIntegrationsTelegramContract);

    const response = await accept(
      client.list({ headers: { authorization: `Bearer ${token}` } }),
      [200],
    );

    expect(response.body.bots).toHaveLength(3);
    expect(response.body.bots).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: OFFICIAL_TELEGRAM_BOT_ID,
          kind: "official",
        }),
        expect.objectContaining({
          id: linkedBotId,
          isOwner: true,
          isConnected: true,
          avatarUrl: expect.stringContaining(
            `/api/integrations/telegram/${linkedBotId}/avatar?exp=`,
          ),
        }),
        expect.objectContaining({
          id: unlinkedBotId,
          isOwner: false,
          isConnected: false,
        }),
      ]),
    );
    expect(
      response.body.bots.some((bot) => {
        return bot.id === otherOrgBotId;
      }),
    ).toBeFalsy();
  });
});

describe("GET /api/integrations/telegram/:botId", () => {
  const fixtures: TelegramFixture[] = [];
  const memberships: OrgMembershipFixture[] = [];

  beforeEach(() => {
    configureOfficialBotEnv();
    server.use(telegramOauthHead("0"));
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
        await store.set(deleteOrgMembership$, membership, context.signal);
      }
    }
  });

  async function seedBotStatusContext(): Promise<{
    readonly token: string;
    readonly botId: string;
    readonly orgId: string;
    readonly userId: string;
  }> {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const membership = await store.set(
      seedOrgMembership$,
      { orgId, userId, seedOrgCache: false },
      context.signal,
    );
    memberships.push(membership);

    const botId = newTelegramBotId();
    context.mocks.telegram.getMe.mockResolvedValue({
      id: Number(botId),
      is_bot: true,
      first_name: "Bot",
      username: "x",
    });
    const builder = makeTelegramFixtureBuilder(orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId: botId },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));

    return {
      token: mintZeroToken({
        userId,
        orgId,
        capabilities: ["telegram:read"],
      }),
      botId,
      orgId,
      userId,
    };
  }

  it("returns 404 when the custom bot is not in the active org", async () => {
    const { token } = await seedBotStatusContext();
    const otherOrgId = `org_${randomUUID()}`;
    const otherBotId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(otherOrgId);
    const otherInstall = await store.set(
      seedTelegramInstallation$,
      {
        orgId: otherOrgId,
        ownerUserId: `user_${randomUUID()}`,
        telegramBotId: otherBotId,
      },
      context.signal,
    );
    builder.composeIds.push(otherInstall.composeId);
    builder.telegramBotIds.push(otherInstall.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));
    const client = setupApp({ context })(zeroIntegrationsTelegramContract);

    const response = await accept(
      client.getBot({
        params: { botId: otherBotId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns full status for a visible custom bot", async () => {
    const { token, botId } = await seedBotStatusContext();
    const client = setupApp({ context })(zeroIntegrationsTelegramContract);

    const response = await accept(
      client.getBot({
        params: { botId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      id: botId,
      isOwner: true,
      isConnected: false,
      tokenStatus: "valid",
      domainConfigured: false,
      environment: {
        requiredSecrets: expect.any(Array),
        requiredVars: expect.any(Array),
        missingSecrets: expect.any(Array),
        missingVars: expect.any(Array),
      },
    });
  });
});

describe("GET /api/integrations/telegram/link", () => {
  const fixtures: TelegramFixture[] = [];
  const memberships: OrgMembershipFixture[] = [];

  beforeEach(() => {
    configureOfficialBotEnv();
    server.use(telegramOauthHead("0"));
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
        await store.set(deleteOrgMembership$, membership, context.signal);
      }
    }
  });

  async function seedLinkContext(): Promise<{
    readonly token: string;
    readonly orgId: string;
    readonly userId: string;
  }> {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const membership = await store.set(
      seedOrgMembership$,
      { orgId, userId, seedOrgCache: false },
      context.signal,
    );
    memberships.push(membership);
    return {
      token: mintZeroToken({
        userId,
        orgId,
        capabilities: ["telegram:read"],
      }),
      orgId,
      userId,
    };
  }

  it("returns linked false without installation when no link exists", async () => {
    const { token } = await seedLinkContext();
    const client = setupApp({ context })(zeroIntegrationsTelegramContract);

    const response = await accept(
      client.getLinkStatus({
        query: {},
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ linked: false });
  });

  it("scopes linked status to the requested bot", async () => {
    const { token, orgId, userId } = await seedLinkContext();
    const linkedBotId = newTelegramBotId();
    const unlinkedBotId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(orgId);

    for (const botId of [linkedBotId, unlinkedBotId]) {
      const installation = await store.set(
        seedTelegramInstallation$,
        { orgId, ownerUserId: userId, telegramBotId: botId },
        context.signal,
      );
      builder.composeIds.push(installation.composeId);
      builder.telegramBotIds.push(installation.telegramBotId);
    }
    fixtures.push(freezeTelegramFixture(builder));
    await store.set(
      seedTelegramUserLink$,
      {
        installationId: linkedBotId,
        telegramUserId: "tg-linked-user",
        vm0UserId: userId,
      },
      context.signal,
    );

    const client = setupApp({ context })(zeroIntegrationsTelegramContract);
    const linkedResponse = await accept(
      client.getLinkStatus({
        query: { botId: linkedBotId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    const unlinkedResponse = await accept(
      client.getLinkStatus({
        query: { botId: unlinkedBotId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(linkedResponse.body).toMatchObject({
      linked: true,
      telegramUserId: "tg-linked-user",
      botUsername: `bot_${linkedBotId}`,
    });
    expect(unlinkedResponse.body).toStrictEqual({
      linked: false,
      installation: {
        id: unlinkedBotId,
        botUsername: `bot_${unlinkedBotId}`,
        loginBotId: unlinkedBotId,
        domainConfigured: false,
      },
    });
  });

  it("returns 403 when the requested bot belongs to another org", async () => {
    const { token } = await seedLinkContext();
    const otherOrgId = `org_${randomUUID()}`;
    const otherBotId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(otherOrgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      {
        orgId: otherOrgId,
        ownerUserId: `user_${randomUUID()}`,
        telegramBotId: otherBotId,
      },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));
    const client = setupApp({ context })(zeroIntegrationsTelegramContract);

    const response = await accept(
      client.getLinkStatus({
        query: { botId: otherBotId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});

describe("GET /api/integrations/telegram/:botId/avatar", () => {
  const fixtures: TelegramFixture[] = [];
  const memberships: OrgMembershipFixture[] = [];

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
        await store.set(deleteOrgMembership$, membership, context.signal);
      }
    }
  });

  function requestPathFromSignedUrl(url: string): string {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  }

  it("streams a signed custom bot avatar without auth", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const membership = await store.set(
      seedOrgMembership$,
      { orgId, userId, seedOrgCache: false },
      context.signal,
    );
    memberships.push(membership);

    const botId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId: botId },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));

    const fileBytes = Buffer.from("telegram avatar bytes");
    context.mocks.telegram.getUserProfilePhotos.mockResolvedValue([
      [
        {
          file_id: "small-avatar",
          width: 64,
          height: 64,
        },
        {
          file_id: "large-avatar",
          width: 320,
          height: 320,
          file_size: fileBytes.length,
        },
      ],
    ]);
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "large-avatar",
      file_size: fileBytes.length,
      file_path: "photos/avatar.jpg",
    });
    server.use(
      http.get(
        "https://api.telegram.org/file/bottest-bot-token/photos/avatar.jpg",
        () => {
          return new HttpResponse(fileBytes, {
            status: 200,
            headers: {
              "content-type": "image/jpeg",
              "content-length": String(fileBytes.length),
            },
          });
        },
      ),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request(
      requestPathFromSignedUrl(buildTelegramBotAvatarUrl(botId)),
    );

    expect(response.status).toBe(200);
    expect(context.mocks.telegram.getUserProfilePhotos).toHaveBeenCalledWith(
      "test-bot-token",
      Number(botId),
      1,
    );
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileBytes)).toBeTruthy();
  });

  it("returns fallback svg when Telegram has no avatar", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const membership = await store.set(
      seedOrgMembership$,
      { orgId, userId, seedOrgCache: false },
      context.signal,
    );
    memberships.push(membership);

    const botId = "tg-bot-no-avatar";
    const builder = makeTelegramFixtureBuilder(orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId: botId },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));
    const token = mintZeroToken({
      userId,
      orgId,
      capabilities: ["telegram:read"],
    });
    context.mocks.telegram.getUserProfilePhotos.mockResolvedValue([]);

    const app = createApp({ signal: context.signal });
    const response = await app.request(
      `/api/integrations/telegram/${botId}/avatar`,
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    await expect(response.text()).resolves.toContain(
      "Telegram bot avatar fallback",
    );
  });
});

describe("GET /api/integrations/telegram/auth-callback", () => {
  it("returns the Telegram auth bridge html", async () => {
    const app = createApp({ signal: context.signal });

    const response = await app.request(
      "/api/integrations/telegram/auth-callback",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    await expect(response.text()).resolves.toContain("telegram-auth");
  });
});

describe("GET /api/zero/integrations/telegram/download-file", () => {
  const fixtures: TelegramFixture[] = [];
  const memberships: OrgMembershipFixture[] = [];
  const downloadPath = "/api/zero/integrations/telegram/download-file";

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
        await store.set(deleteOrgMembership$, membership, context.signal);
      }
    }
  });

  function requestDownload(args: {
    readonly search: string;
    readonly token?: string;
    readonly authorization?: string;
  }): Response | Promise<Response> {
    const headers: Record<string, string> = {};
    if (args.token) {
      headers.authorization = `Bearer ${args.token}`;
    }
    if (args.authorization) {
      headers.authorization = args.authorization;
    }
    const app = createApp({ signal: context.signal });
    return app.request(`${downloadPath}${args.search}`, { headers });
  }

  async function seedDownloadContext(): Promise<{
    readonly token: string;
    readonly botId: string;
  }> {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const membership = await store.set(
      seedOrgMembership$,
      { orgId, userId, seedOrgCache: false },
      context.signal,
    );
    memberships.push(membership);

    const builder = makeTelegramFixtureBuilder(orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      {
        orgId,
        ownerUserId: userId,
        telegramBotId: newTelegramBotId(),
      },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));

    return {
      token: mintZeroToken({
        userId,
        orgId,
        capabilities: ["telegram:read"],
      }),
      botId: installation.telegramBotId,
    };
  }

  async function seedReadToken(): Promise<string> {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const membership = await store.set(
      seedOrgMembership$,
      { orgId, userId, seedOrgCache: false },
      context.signal,
    );
    memberships.push(membership);
    return mintZeroToken({
      userId,
      orgId,
      capabilities: ["telegram:read"],
    });
  }

  function expectJson(response: Response): Promise<unknown> {
    expect(response.headers.get("content-type")).toContain("application/json");
    return response.json();
  }

  it("returns 401 when no auth token is provided", async () => {
    const response = await requestDownload({
      search: "?file_id=tg-file-1&bot_id=tg-bot",
    });

    expect(response.status).toBe(401);
    expectUnauthorized(await expectJson(response));
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const response = await requestDownload({
      search: "?file_id=tg-file-1&bot_id=tg-bot",
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(401);
    expectUnauthorized(await expectJson(response));
  });

  it("returns 400 when file_id query param is missing", async () => {
    const token = await seedReadToken();

    const response = await requestDownload({
      search: "?bot_id=tg-bot",
      token,
    });

    expect(response.status).toBe(400);
    const body = await expectJson(response);
    expect(body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(JSON.stringify(body)).toContain("file_id");
  });

  it("returns 400 when bot_id query param is missing", async () => {
    const token = await seedReadToken();

    const response = await requestDownload({
      search: "?file_id=tg-file-1",
      token,
    });

    expect(response.status).toBe(400);
    const body = await expectJson(response);
    expect(body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(JSON.stringify(body)).toContain("bot_id");
  });

  it("returns 404 when the custom bot id is not known in the org", async () => {
    const token = await seedReadToken();

    const response = await requestDownload({
      search: "?file_id=tg-missing&bot_id=unknown-bot",
      token,
    });

    expect(response.status).toBe(404);
    await expect(expectJson(response)).resolves.toStrictEqual({
      error: { message: "Telegram bot not found", code: "NOT_FOUND" },
    });
  });

  it("streams files for the official Telegram bot", async () => {
    const token = await seedReadToken();
    const fileBytes = Buffer.from("official telegram bytes");
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "tg-official",
      file_size: fileBytes.length,
      file_path: "photos/official.jpg",
    });
    server.use(
      http.get(
        `https://api.telegram.org/file/bot${OFFICIAL_BOT_TOKEN}/photos/official.jpg`,
        () => {
          return new HttpResponse(fileBytes, {
            status: 200,
            headers: {
              "content-type": "image/jpeg",
              "content-length": String(fileBytes.length),
            },
          });
        },
      ),
    );

    const response = await requestDownload({
      search: `?file_id=tg-official&bot_id=${OFFICIAL_TELEGRAM_BOT_ID}`,
      token,
    });

    expect(response.status).toBe(200);
    expect(context.mocks.telegram.getFile).toHaveBeenCalledWith(
      OFFICIAL_BOT_TOKEN,
      "tg-official",
    );
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("x-file-name")).toBe("official.jpg");
    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileBytes)).toBeTruthy();
  });

  it("streams files for a custom Telegram bot", async () => {
    const { token, botId } = await seedDownloadContext();
    const fileBytes = Buffer.from("custom telegram bytes");
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "tg-custom",
      file_size: fileBytes.length,
      file_path: "photos/custom.jpg",
    });
    server.use(
      http.get(
        "https://api.telegram.org/file/bottest-bot-token/photos/custom.jpg",
        () => {
          return new HttpResponse(fileBytes, {
            status: 200,
            headers: {
              "content-type": "image/jpeg",
              "content-length": String(fileBytes.length),
            },
          });
        },
      ),
    );

    const response = await requestDownload({
      search: `?file_id=tg-custom&bot_id=${botId}`,
      token,
    });

    expect(response.status).toBe(200);
    expect(context.mocks.telegram.getFile).toHaveBeenCalledWith(
      "test-bot-token",
      "tg-custom",
    );
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("x-file-mimetype")).toBe("image/jpeg");
    expect(response.headers.get("x-file-name")).toBe("custom.jpg");
    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileBytes)).toBeTruthy();
  });

  it("returns 404 when Telegram file metadata has no downloadable path", async () => {
    const { token, botId } = await seedDownloadContext();
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "tg-no-path",
    });

    const response = await requestDownload({
      search: `?file_id=tg-no-path&bot_id=${botId}`,
      token,
    });

    expect(response.status).toBe(404);
    await expect(expectJson(response)).resolves.toStrictEqual({
      error: {
        message: "Telegram file does not have a downloadable path",
        code: "NOT_FOUND",
      },
    });
  });

  it("returns 413 when Telegram reports a file over the proxy limit", async () => {
    const { token, botId } = await seedDownloadContext();
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "tg-file-big",
      file_size: 200 * 1024 * 1024,
      file_path: "documents/big.bin",
    });

    const response = await requestDownload({
      search: `?file_id=tg-file-big&bot_id=${botId}`,
      token,
    });

    expect(response.status).toBe(413);
    await expect(expectJson(response)).resolves.toStrictEqual({
      error: {
        message: "File exceeds maximum size of 104857600 bytes",
        code: "PAYLOAD_TOO_LARGE",
      },
    });
  });

  it("returns 413 when download content-length exceeds the proxy limit", async () => {
    const { token, botId } = await seedDownloadContext();
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "tg-huge-response",
      file_path: "documents/huge-response.bin",
    });
    server.use(
      http.get(
        "https://api.telegram.org/file/bottest-bot-token/documents/huge-response.bin",
        () => {
          return new HttpResponse(Buffer.from("not actually huge"), {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(200 * 1024 * 1024),
            },
          });
        },
      ),
    );

    const response = await requestDownload({
      search: `?file_id=tg-huge-response&bot_id=${botId}`,
      token,
    });

    expect(response.status).toBe(413);
    await expect(expectJson(response)).resolves.toStrictEqual({
      error: {
        message: "File exceeds maximum size of 104857600 bytes",
        code: "PAYLOAD_TOO_LARGE",
      },
    });
  });

  it("returns 502 when Telegram returns HTML for a file download", async () => {
    const { token, botId } = await seedDownloadContext();
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "tg-html",
      file_path: "documents/html.bin",
    });
    server.use(
      http.get(
        "https://api.telegram.org/file/bottest-bot-token/documents/html.bin",
        () => {
          return new HttpResponse("<html></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        },
      ),
    );

    const response = await requestDownload({
      search: `?file_id=tg-html&bot_id=${botId}`,
      token,
    });

    expect(response.status).toBe(502);
    await expect(expectJson(response)).resolves.toStrictEqual({
      error: {
        message: "Telegram returned an unexpected response",
        code: "BAD_GATEWAY",
      },
    });
  });

  it("returns 502 when Telegram file download returns a non-OK response", async () => {
    const { token, botId } = await seedDownloadContext();
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "tg-download-fail",
      file_path: "documents/fail.bin",
    });
    server.use(
      http.get(
        "https://api.telegram.org/file/bottest-bot-token/documents/fail.bin",
        () => {
          return new HttpResponse("unavailable", { status: 503 });
        },
      ),
    );

    const response = await requestDownload({
      search: `?file_id=tg-download-fail&bot_id=${botId}`,
      token,
    });

    expect(response.status).toBe(502);
    await expect(expectJson(response)).resolves.toStrictEqual({
      error: {
        message: "Failed to download file from Telegram: 503",
        code: "BAD_GATEWAY",
      },
    });
  });

  it("returns a generic 502 body when Telegram file lookup throws", async () => {
    const { token, botId } = await seedDownloadContext();
    context.mocks.telegram.getFile.mockRejectedValue(
      new Error("upstream detail"),
    );

    const response = await requestDownload({
      search: `?file_id=tg-throws&bot_id=${botId}`,
      token,
    });

    expect(response.status).toBe(502);
    await expect(expectJson(response)).resolves.toStrictEqual({
      error: {
        message: "Failed to download file from Telegram",
        code: "BAD_GATEWAY",
      },
    });
  });
});
