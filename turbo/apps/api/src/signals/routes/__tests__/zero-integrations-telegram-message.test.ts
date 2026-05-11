import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";

import { integrationsTelegramMessageContract } from "@vm0/api-contracts/contracts/integrations";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import {
  deleteTelegramFixture$,
  seedTelegramInstallation$,
  type TelegramFixture,
} from "./helpers/zero-telegram";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { seedRun$ } from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function uniqueBotId(): string {
  // 9-digit numeric matches parseTelegramBotId's /^\d+$/ check.
  return String(100_000_000 + Math.floor(Math.random() * 899_999_999));
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: ["telegram:write"],
    iat: seconds,
    exp: seconds + 60,
  });
}

async function setRunSelectedModel(
  runId: string,
  selectedModel: string,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .update(zeroRuns)
    .set({ selectedModel })
    .where(eq(zeroRuns.id, runId));
}

async function insertTelegramUserLink(values: {
  readonly installationId: string;
  readonly vm0UserId: string;
  readonly telegramUserId: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(telegramUserLinks).values({
    installationId: values.installationId,
    vm0UserId: values.vm0UserId,
    telegramUserId: values.telegramUserId,
    telegramUsername: values.telegramUsername ?? null,
    telegramDisplayName: values.telegramDisplayName ?? null,
  });
}

interface TelegramMessageFixture extends TelegramFixture {
  readonly composeId: string;
  readonly telegramBotId: string;
  readonly userId: string;
  readonly runId: string;
  readonly membership: OrgMembershipFixture;
}

async function seedSendableContext(args: {
  readonly displayName?: string;
}): Promise<TelegramMessageFixture> {
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const userId = `user_${randomUUID().slice(0, 8)}`;

  // Seed the org/member cache so the auth pipeline's role lookup hits the
  // cache instead of trying to call out to Clerk.
  const membership = await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );

  const telegramBotId = uniqueBotId();
  const installation = await store.set(
    seedTelegramInstallation$,
    {
      orgId,
      ownerUserId: userId,
      telegramBotId,
    },
    context.signal,
  );

  // Override the seed helper's default zero_agents.displayName (null) so the
  // footer asserts a known label.
  if (args.displayName) {
    const writeDb = store.set(writeDb$);
    await writeDb
      .update(zeroAgents)
      .set({ displayName: args.displayName })
      .where(eq(zeroAgents.id, installation.composeId));
  }

  const { runId } = await store.set(
    seedRun$,
    { orgId, userId, composeId: installation.composeId },
    context.signal,
  );

  return {
    orgId,
    composeIds: [installation.composeId],
    composeId: installation.composeId,
    telegramBotIds: [telegramBotId],
    telegramBotId,
    userIds: [userId],
    userId,
    runId,
    membership,
  };
}

describe("POST /api/zero/integrations/telegram/message", () => {
  const fixtures: TelegramFixture[] = [];

  function trackFixture(fixture: TelegramMessageFixture): void {
    fixtures.push(fixture);
    memberships.push(fixture.membership);
  }

  const memberships: OrgMembershipFixture[] = [];

  // afterEach guarantees cleanup even when an assertion fails mid-test.
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
    const client = setupApp({ context })(integrationsTelegramMessageContract);
    const response = await accept(
      client.sendMessage({
        body: {
          botId: "tg-bot",
          chatId: "-100",
          text: "hi",
        },
        headers: {},
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const client = setupApp({ context })(integrationsTelegramMessageContract);

    const response = await accept(
      client.sendMessage({
        body: {
          botId: "tg-bot",
          chatId: "-100",
          text: "hi",
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("sends a Telegram message and appends the audit footer", async () => {
    const fixture = await seedSendableContext({
      displayName: "My Assistant",
    });
    trackFixture(fixture);
    await setRunSelectedModel(fixture.runId, "claude-opus-4-7");
    await insertTelegramUserLink({
      installationId: fixture.telegramBotId,
      vm0UserId: fixture.userId,
      telegramUserId: "777000",
      telegramUsername: "ada_telegram",
      telegramDisplayName: "Ada Lovelace",
    });

    let telegramBody: Record<string, unknown> | undefined;
    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/sendMessage",
        async ({ request }) => {
          telegramBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            ok: true,
            result: {
              message_id: 321,
              chat: { id: -1_001_234_567_890 },
              text: telegramBody.text,
            },
          });
        },
      ),
    );

    const client = setupApp({ context })(integrationsTelegramMessageContract);
    const response = await accept(
      client.sendMessage({
        body: {
          botId: fixture.telegramBotId,
          chatId: "-1001234567890",
          text: "Hello **world**",
          replyToMessageId: 42,
          messageThreadId: 7,
        },
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId: fixture.runId,
          })}`,
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      ok: true,
      messageId: 321,
      chatId: "-1001234567890",
    });

    expect(telegramBody).toMatchObject({
      chat_id: "-1001234567890",
      parse_mode: "HTML",
      reply_parameters: { message_id: 42 },
      message_thread_id: 7,
    });
    const sentText = String(telegramBody?.text);
    expect(sentText).toContain("Hello <b>world</b>");
    expect(sentText).toContain(
      '<i>Sent via My Assistant · Triggered by <a href="tg://user?id=777000">@ada_telegram</a> · Claude Opus 4.7</i>',
    );
  });

  it("falls back to Telegram display name in the footer when username is absent", async () => {
    const fixture = await seedSendableContext({});
    trackFixture(fixture);
    await insertTelegramUserLink({
      installationId: fixture.telegramBotId,
      vm0UserId: fixture.userId,
      telegramUserId: "777001",
      telegramUsername: null,
      telegramDisplayName: "Ada Lovelace",
    });

    let telegramBody: Record<string, unknown> | undefined;
    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/sendMessage",
        async ({ request }) => {
          telegramBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            ok: true,
            result: {
              message_id: 322,
              chat: { id: -1_001_234_567_890 },
              text: telegramBody.text,
            },
          });
        },
      ),
    );

    const client = setupApp({ context })(integrationsTelegramMessageContract);
    const response = await accept(
      client.sendMessage({
        body: {
          botId: fixture.telegramBotId,
          chatId: "-1001234567890",
          text: "Hello",
        },
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId: fixture.runId,
          })}`,
        },
      }),
      [200],
    );
    expect(response.body.ok).toBeTruthy();

    const sentText = String(telegramBody?.text);
    expect(sentText).toContain(
      'Triggered by <a href="tg://user?id=777001">Ada Lovelace</a>',
    );
  });

  it("returns 404 when the bot id is not owned by the org", async () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID()}`;
    const membership = await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    );
    memberships.push(membership);

    const client = setupApp({ context })(integrationsTelegramMessageContract);
    const response = await accept(
      client.sendMessage({
        body: {
          botId: uniqueBotId(),
          chatId: "-1001234567890",
          text: "hello",
        },
        headers: {
          authorization: `Bearer ${zeroToken({ userId, orgId, runId })}`,
        },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Telegram bot not found", code: "NOT_FOUND" },
    });
  });

  it("returns 400 when Telegram rejects sendMessage with a 4xx", async () => {
    const fixture = await seedSendableContext({});
    trackFixture(fixture);

    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/sendMessage",
        () => {
          return HttpResponse.json(
            {
              ok: false,
              description: "Bad Request: chat not found",
            },
            { status: 400 },
          );
        },
      ),
    );

    const client = setupApp({ context })(integrationsTelegramMessageContract);
    const response = await accept(
      client.sendMessage({
        body: {
          botId: fixture.telegramBotId,
          chatId: "-1001234567890",
          text: "hello",
        },
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId: fixture.runId,
          })}`,
        },
      }),
      [400],
    );
    expect(response.body.error.code).toBe("TELEGRAM_ERROR");
    expect(response.body.error.message).toContain("chat not found");
  });

  it("returns 502 when Telegram returns a 5xx (api defensive mapping)", async () => {
    const fixture = await seedSendableContext({});
    trackFixture(fixture);

    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/sendMessage",
        () => {
          return HttpResponse.json(
            {
              ok: false,
              description: "Service Unavailable",
            },
            { status: 503 },
          );
        },
      ),
    );

    const client = setupApp({ context })(integrationsTelegramMessageContract);
    const response = await accept(
      client.sendMessage({
        body: {
          botId: fixture.telegramBotId,
          chatId: "-1001234567890",
          text: "hello",
        },
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId: fixture.runId,
          })}`,
        },
      }),
      [502],
    );
    expect(response.body.error.code).toBe("TELEGRAM_ERROR");
    expect(response.body.error.message).toContain("Service Unavailable");
  });
});
