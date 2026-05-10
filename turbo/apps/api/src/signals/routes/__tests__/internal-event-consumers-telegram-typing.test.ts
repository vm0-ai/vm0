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

describe("POST /api/internal/event-consumers/telegram-typing", () => {
  const fixtures: TelegramFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteTelegramFixture$, fixture, context.signal);
      }
    }
  });

  it("rejects invalid signatures", async () => {
    const app = createApp({ signal: context.signal });
    const rawBody = JSON.stringify({
      runId: "r",
      events: [],
      context: { userId: "u", orgId: "o" },
    });

    const response = await app.request(PATH, {
      method: "POST",
      headers: signedHeaders(rawBody, "wrong-key"),
      body: rawBody,
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Invalid signature");
  });

  it("refreshes typing for pending Telegram callbacks", async () => {
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

    // Override the encrypted bot token with one matching our MSW handler.
    const writeDb = store.set(writeDb$);
    await writeDb
      .update(telegramInstallations)
      .set({ encryptedBotToken: encryptSecretForTests(token) })
      .where(eq(telegramInstallations.telegramBotId, telegramBotId));

    const { runId } = await store.set(
      seedRun$,
      { orgId, userId, composeId },
      context.signal,
    );

    await store.set(
      seedAgentRunCallback$,
      {
        runId,
        url: "http://localhost/api/internal/callbacks/telegram",
        payload: { installationId: telegramBotId, chatId: "chat-123" },
      },
      context.signal,
    );

    const tgCalls: { chat_id: string; action: string }[] = [];
    server.use(
      http.post(
        `https://api.telegram.org/bot${token}/sendChatAction`,
        async ({ request }) => {
          tgCalls.push(
            (await request.json()) as { chat_id: string; action: string },
          );
          return HttpResponse.json({ ok: true, result: true });
        },
      ),
    );

    const app = createApp({ signal: context.signal });
    const rawBody = JSON.stringify({
      runId,
      events: [{ type: "assistant", sequenceNumber: 1 }],
      context: { userId, orgId },
    });
    const response = await app.request(PATH, {
      method: "POST",
      headers: signedHeaders(rawBody),
      body: rawBody,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { scheduled: true };
    expect(body).toStrictEqual({ scheduled: true });

    // Force the detached waitUntil work to settle before asserting on side effects.
    await clearAllDetached();

    expect(tgCalls).toStrictEqual([{ chat_id: "chat-123", action: "typing" }]);
  });

  it("does nothing when the run has no Telegram callbacks", async () => {
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

    const { runId } = await store.set(
      seedRun$,
      { orgId, userId, composeId },
      context.signal,
    );

    const tgCalls: unknown[] = [];
    server.use(
      http.post(
        `https://api.telegram.org/bot${token}/sendChatAction`,
        async ({ request }) => {
          tgCalls.push(await request.json());
          return HttpResponse.json({ ok: true, result: true });
        },
      ),
    );

    const app = createApp({ signal: context.signal });
    const rawBody = JSON.stringify({
      runId,
      events: [{ type: "tool_result", sequenceNumber: 1 }],
      context: { userId, orgId },
    });
    const response = await app.request(PATH, {
      method: "POST",
      headers: signedHeaders(rawBody),
      body: rawBody,
    });

    expect(response.status).toBe(200);
    await clearAllDetached();
    expect(tgCalls).toStrictEqual([]);
  });
});
