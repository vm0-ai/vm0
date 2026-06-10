import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { clearAllDetached } from "../../utils";
import { writeDb$ } from "../../external/db";
import { seedAgentRunCallback$ } from "./helpers/agent-run-callback";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
import {
  deleteTelegramFixture$,
  seedTelegramInstallation$,
  type TelegramFixture,
} from "./helpers/zero-telegram";
import { seedRun$ } from "./helpers/zero-usage-insight";

// BDD migration of the legacy
// `internal-event-consumers-telegram-typing.test.ts`. The
// 3 legacy `it()`s collapse into 2 BDD `it()`s: (1) auth
// chain (401 invalid signature), (2) success chain (200
// refreshes typing for pending Telegram callbacks with
// upstream MSW capture → 200 does nothing when the run has
// no Telegram callbacks).
//
// Service-Level Exception: the upstream Telegram
// sendChatAction API is mocked via MSW. The `fixtures`
// array is closed over a `createHarness()` factory inside
// each describe so the mutable package-scope lint rule
// (`api/no-package-variable`) is satisfied.

const SECRETS_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PATH = "/api/internal/event-consumers/telegram-typing";

const context = testContext();
const store = createStore();

function uniqueBotId(): string {
  // 9-digit numeric so parseTelegramBotId's /^\d+$/ check accepts it.
  return String(100_000_000 + Math.floor(Math.random() * 899_999_999));
}

function botToken(botId: string): string {
  return `${botId}:ABC-test-telegram-typing`;
}

function signedHeaders(
  rawBody: string,
  secret: string = SECRETS_ENCRYPTION_KEY,
): Record<string, string> {
  const ts = Math.floor(now() / 1000);
  return {
    "X-VM0-Signature": computeHmacSignature(rawBody, secret, ts),
    "X-VM0-Timestamp": String(ts),
    "Content-Type": "application/json",
  };
}

function createHarness(): {
  readonly setupTelegramContext: () => Promise<{
    readonly orgId: string;
    readonly userId: string;
    readonly composeId: string;
    readonly telegramBotId: string;
    readonly token: string;
  }>;
} {
  const fixtures: TelegramFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteTelegramFixture$, fixture, context.signal);
      }
    }
  });

  const setupTelegramContext = async (): Promise<{
    readonly orgId: string;
    readonly userId: string;
    readonly composeId: string;
    readonly telegramBotId: string;
    readonly token: string;
  }> => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const composeId = randomUUID();
    const telegramBotId = uniqueBotId();
    const token = botToken(telegramBotId);

    fixtures.push({
      orgId,
      composeIds: [composeId],
      telegramBotIds: [telegramBotId],
      userIds: [userId],
    });

    await store.set(
      seedTelegramInstallation$,
      {
        orgId,
        ownerUserId: userId,
        telegramBotId,
        defaultComposeId: composeId,
      },
      context.signal,
    );

    return { orgId, userId, composeId, telegramBotId, token };
  };

  return { setupTelegramContext };
}

describe("BDD POST /api/internal/event-consumers/telegram-typing — 401 auth chain", () => {
  it("gwt-wt-wt: 401 invalid signature", async () => {
    // When: post a request with an invalid signature.
    const app = createApp({ signal: context.signal });
    const rawBody = JSON.stringify({
      runId: "r",
      events: [],
      context: { userId: "u", orgId: "o" },
    });

    // Then: 401.
    const response = await app.request(PATH, {
      method: "POST",
      headers: signedHeaders(rawBody, "wrong-key"),
      body: rawBody,
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Invalid signature");
  });
});

describe("BDD POST /api/internal/event-consumers/telegram-typing — 200 success chain", () => {
  const { setupTelegramContext } = createHarness();

  it("gwt-wt-wt: 200 refreshes typing for pending Telegram callbacks → 200 does nothing when the run has no Telegram callbacks", async () => {
    // Given: a Telegram installation + an agent-run callback
    // + an MSW handler for the sendChatAction call.
    const ctx = await setupTelegramContext();

    // Override the encrypted bot token with one matching our
    // MSW handler.
    const writeDb = store.set(writeDb$);
    await writeDb
      .update(telegramInstallations)
      .set({ encryptedBotToken: encryptSecretForTests(ctx.token) })
      .where(eq(telegramInstallations.telegramBotId, ctx.telegramBotId));

    const { runId } = await store.set(
      seedRun$,
      { orgId: ctx.orgId, userId: ctx.userId, composeId: ctx.composeId },
      context.signal,
    );

    await store.set(
      seedAgentRunCallback$,
      {
        runId,
        url: "http://localhost/api/internal/callbacks/telegram",
        payload: {
          installationId: ctx.telegramBotId,
          chatId: "chat-123",
        },
      },
      context.signal,
    );

    const tgCalls: { chat_id: string; action: string }[] = [];
    server.use(
      http.post(
        `https://api.telegram.org/bot${ctx.token}/sendChatAction`,
        async ({ request }) => {
          tgCalls.push(
            (await request.json()) as { chat_id: string; action: string },
          );
          return HttpResponse.json({ ok: true, result: true });
        },
      ),
    );

    // When: post a typing event.
    const app = createApp({ signal: context.signal });
    const rawBody = JSON.stringify({
      runId,
      events: [{ type: "assistant", sequenceNumber: 1 }],
      context: { userId: ctx.userId, orgId: ctx.orgId },
    });
    const response = await app.request(PATH, {
      method: "POST",
      headers: signedHeaders(rawBody),
      body: rawBody,
    });

    // Then: 200 + the response is `{ scheduled: true }` +
    // the upstream Telegram API receives the expected
    // sendChatAction call.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { scheduled: true };
    expect(body).toStrictEqual({ scheduled: true });
    await clearAllDetached();
    expect(tgCalls).toStrictEqual([
      { chat_id: "chat-123", action: "typing" },
    ]);

    // Given: a fresh run without any Telegram callbacks
    // + the previous MSW handler (which would record calls)
    // is replaced with one that asserts no calls happen.
    const ctx2 = await setupTelegramContext();
    const { runId: runId2 } = await store.set(
      seedRun$,
      { orgId: ctx2.orgId, userId: ctx2.userId, composeId: ctx2.composeId },
      context.signal,
    );

    const tgCalls2: unknown[] = [];
    server.resetHandlers();
    server.use(
      http.post(
        `https://api.telegram.org/bot${ctx2.token}/sendChatAction`,
        async ({ request }) => {
          tgCalls2.push(await request.json());
          return HttpResponse.json({ ok: true, result: true });
        },
      ),
    );

    // When: post a non-assistant event.
    const rawBody2 = JSON.stringify({
      runId: runId2,
      events: [{ type: "tool_result", sequenceNumber: 1 }],
      context: { userId: ctx2.userId, orgId: ctx2.orgId },
    });
    const response2 = await app.request(PATH, {
      method: "POST",
      headers: signedHeaders(rawBody2),
      body: rawBody2,
    });

    // Then: 200 + the upstream Telegram API is not called.
    expect(response2.status).toBe(200);
    await clearAllDetached();
    expect(tgCalls2).toStrictEqual([]);
  });
});
