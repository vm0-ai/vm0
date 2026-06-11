import { randomUUID } from "node:crypto";

import { integrationsTelegramMessageContract } from "@vm0/api-contracts/contracts/integrations";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, describe, it } from "vitest";

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
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { seedRun$ } from "./helpers/zero-usage-insight";

// BDD migration of the legacy
// `zero-integrations-telegram-message.test.ts`. The 8
// legacy `it()`s collapse into 3 BDD `it()`s:
// (1) auth + not-found chain (401 unauth → 401 no org
// membership → 401 no org in session → 404 bot not in
// org),
// (2) send + footer chain (200 sends with parse_mode
// HTML + reply_parameters + thread + footer with
// username → 200 falls back to Telegram display name in
// footer when username absent),
// (3) error mapping chain (400 forwards Telegram 4xx
// error → 502 maps Telegram 5xx to BAD_GATEWAY).

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

const trackTelegram = createFixtureTracker<TelegramFixture>((fixture) => {
  return store.set(deleteTelegramFixture$, fixture, context.signal);
});
const trackMembership = createFixtureTracker<OrgMembershipFixture>(
  (fixture) => {
    return store.set(deleteOrgMembership$, fixture, context.signal);
  },
);

function client() {
  return setupApp({ context })(integrationsTelegramMessageContract);
}

describe("BDD POST /api/zero/integrations/telegram/message — auth + not-found chain", () => {
  afterEach(async () => {
    // The chain never calls trackX, so afterEach just
    // needs to ensure clean state between tests.
  });

  it("gwt-wt-wt: 401 unauth → 401 no org membership → 401 no org in session → 404 bot not in org", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      client().sendMessage({
        body: { botId: "tg-bot", chatId: "-100", text: "hi" },
        headers: {},
      }),
      [401],
    );
    expect(noAuth.body.error.code).toBe("UNAUTHORIZED");

    // Given: a zero token whose Clerk user has no
    // organization membership.

    // When + Then: 401.
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const noOrgToken = zeroToken({ userId, orgId, runId: "run-1" });
    const noOrg = await accept(
      client().sendMessage({
        body: { botId: "tg-bot", chatId: "-100", text: "hi" },
        headers: { authorization: `Bearer ${noOrgToken}` },
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a Clerk session with no org.

    // When + Then: 401.
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrgSession = await accept(
      client().sendMessage({
        body: { botId: "tg-bot", chatId: "-100", text: "hi" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(noOrgSession.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a valid membership + zero token for a
    // random non-existent bot id.

    // When + Then: 404 — Telegram bot not found.
    const membership = await trackMembership(
      store.set(
        seedOrgMembership$,
        {
          orgId: `org_${randomUUID().slice(0, 8)}`,
          userId: `user_${randomUUID().slice(0, 8)}`,
          role: "admin",
        },
        context.signal,
      ),
    );
    const notFoundResponse = await accept(
      client().sendMessage({
        body: {
          botId: uniqueBotId(),
          chatId: "-1001234567890",
          text: "hello",
        },
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: membership.userId,
            orgId: membership.orgId,
            runId: `run_${randomUUID()}`,
          })}`,
        },
      }),
      [404],
    );
    expect(notFoundResponse.body).toStrictEqual({
      error: { message: "Telegram bot not found", code: "NOT_FOUND" },
    });
  });
});

describe("BDD POST /api/zero/integrations/telegram/message — send + footer chain", () => {
  afterEach(() => {
    server.resetHandlers();
  });

  it("gwt-wt-wt: 200 sends with parse_mode=HTML + reply_parameters + thread + footer → 200 falls back to Telegram display name in footer when username absent", async () => {
    // Given: a sendable context with a known displayName
    // + a Telegram user link with username + a
    // selectedModel + a Telegram sendMessage MSW
    // handler that captures the request body.

    // When + Then: 200 — response contains ok +
    // messageId + chatId + the request body contains
    // chat_id + parse_mode=HTML + reply_parameters +
    // message_thread_id + the sent text contains the
    // HTML-bolded text + the footer with username.
    const usernameFixture = await seedSendableContext({
      displayName: "My Assistant",
    });
    trackTelegram(Promise.resolve(usernameFixture));
    trackMembership(Promise.resolve(usernameFixture.membership));
    await setRunSelectedModel(usernameFixture.runId, "claude-opus-4-7");
    await insertTelegramUserLink({
      installationId: usernameFixture.telegramBotId,
      vm0UserId: usernameFixture.userId,
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
    const usernameResponse = await accept(
      client().sendMessage({
        body: {
          botId: usernameFixture.telegramBotId,
          chatId: "-1001234567890",
          text: "Hello **world**",
          replyToMessageId: 42,
          messageThreadId: 7,
        },
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: usernameFixture.userId,
            orgId: usernameFixture.orgId,
            runId: usernameFixture.runId,
          })}`,
        },
      }),
      [200],
    );
    expect(usernameResponse.body).toStrictEqual({
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

    // Given: a sendable context + a Telegram user link
    // without username + a Telegram sendMessage MSW
    // handler that captures the body.

    // When + Then: 200 — the footer falls back to the
    // Telegram display name.
    const displayNameFixture = await seedSendableContext({});
    trackTelegram(Promise.resolve(displayNameFixture));
    trackMembership(Promise.resolve(displayNameFixture.membership));
    await insertTelegramUserLink({
      installationId: displayNameFixture.telegramBotId,
      vm0UserId: displayNameFixture.userId,
      telegramUserId: "777001",
      telegramUsername: null,
      telegramDisplayName: "Ada Lovelace",
    });
    let displayNameBody: Record<string, unknown> | undefined;
    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/sendMessage",
        async ({ request }) => {
          displayNameBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            ok: true,
            result: {
              message_id: 322,
              chat: { id: -1_001_234_567_890 },
              text: displayNameBody.text,
            },
          });
        },
      ),
    );
    const displayNameResponse = await accept(
      client().sendMessage({
        body: {
          botId: displayNameFixture.telegramBotId,
          chatId: "-1001234567890",
          text: "Hello",
        },
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: displayNameFixture.userId,
            orgId: displayNameFixture.orgId,
            runId: displayNameFixture.runId,
          })}`,
        },
      }),
      [200],
    );
    expect(displayNameResponse.body.ok).toBeTruthy();
    const displayNameSentText = String(displayNameBody?.text);
    expect(displayNameSentText).toContain(
      'Triggered by <a href="tg://user?id=777001">Ada Lovelace</a>',
    );
  });
});

describe("BDD POST /api/zero/integrations/telegram/message — error mapping chain", () => {
  afterEach(() => {
    server.resetHandlers();
  });

  it("gwt-wt-wt: 400 forwards Telegram 4xx error → 502 maps Telegram 5xx to BAD_GATEWAY", async () => {
    // Given: a sendable context + a Telegram
    // sendMessage MSW handler that returns 400 with
    // "chat not found".

    // When + Then: 400 — TELEGRAM_ERROR with "chat not
    // found".
    const badRequestFixture = await seedSendableContext({});
    trackTelegram(Promise.resolve(badRequestFixture));
    trackMembership(Promise.resolve(badRequestFixture.membership));
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
    const badRequestResponse = await accept(
      client().sendMessage({
        body: {
          botId: badRequestFixture.telegramBotId,
          chatId: "-1001234567890",
          text: "hello",
        },
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: badRequestFixture.userId,
            orgId: badRequestFixture.orgId,
            runId: badRequestFixture.runId,
          })}`,
        },
      }),
      [400],
    );
    expect(badRequestResponse.body.error.code).toBe("TELEGRAM_ERROR");
    expect(badRequestResponse.body.error.message).toContain("chat not found");

    // Given: a sendable context + a Telegram
    // sendMessage MSW handler that returns 503 with
    // "Service Unavailable".

    // When + Then: 502 — TELEGRAM_ERROR with "Service
    // Unavailable".
    const serviceDownFixture = await seedSendableContext({});
    trackTelegram(Promise.resolve(serviceDownFixture));
    trackMembership(Promise.resolve(serviceDownFixture.membership));
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
    const serviceDownResponse = await accept(
      client().sendMessage({
        body: {
          botId: serviceDownFixture.telegramBotId,
          chatId: "-1001234567890",
          text: "hello",
        },
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: serviceDownFixture.userId,
            orgId: serviceDownFixture.orgId,
            runId: serviceDownFixture.runId,
          })}`,
        },
      }),
      [502],
    );
    expect(serviceDownResponse.body.error.code).toBe("TELEGRAM_ERROR");
    expect(serviceDownResponse.body.error.message).toContain(
      "Service Unavailable",
    );
  });
});
