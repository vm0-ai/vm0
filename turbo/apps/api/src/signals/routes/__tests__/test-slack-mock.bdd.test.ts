import { createStore } from "ccstate";
import {
  SLACK_E2E_FIXTURES,
  SLACK_E2E_SCOPES,
  type TestSlackMockUsersInfoResponse,
} from "@vm0/api-contracts/contracts/test-slack-mock";
import { e2eSlackMockCallLog } from "@vm0/db/schema/e2e-slack-mock-call-log";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";

// BDD migration of the legacy `test-slack-mock.test.ts`. The
// 13 legacy `it()`s collapse into 3 BDD `it()`s: (1) 404
// production-env chain (404 auth.test → 404
// assistant.threads.setStatus → 404 chat.postMessage → 404
// chat.postEphemeral → 404 oauth.v2.access → 404
// views.publish → 404 conversations.history → 404
// conversations.open → 404 conversations.replies → 404
// users.info), (2) 200 dev-env fixture chain (200 returns
// fixed Slack auth.test and oauth.v2.access fixture payloads
// → 200 returns fixed Slack conversation and ack payloads →
// 200 reads users.info user ids from JSON and form-encoded
// bodies with fixture fallback), (3) 200 logged-call chain
// (200 logs chat.postMessage and chat.postEphemeral calls +
// DB log rows written).
//
// Service-Level Exception: `e2eSlackMockCallLog` rows are
// read directly via `writeDb$` because no public GET
// endpoint exists for a single mock call log.

const context = testContext();
const store = createStore();
const writeDb = store.set(writeDb$);

const BASE_ROUTE = "/api/test/slack-mock";
const LOG_TEST_TEAM_ID = "T_TEST_SLACK_MOCK_12859";

function requestApp(path: string, init?: RequestInit): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function cleanupMockCallLog(): Promise<void> {
  await writeDb
    .delete(e2eSlackMockCallLog)
    .where(eq(e2eSlackMockCallLog.teamId, LOG_TEST_TEAM_ID));
}

afterEach(async () => {
  await cleanupMockCallLog();
});

describe("BDD POST /api/test/slack-mock/* — 404 production-env chain", () => {
  it("gwt-wt-wt: 404 auth.test → 404 assistant.threads.setStatus → 404 chat.postMessage → 404 chat.postEphemeral → 404 oauth.v2.access → 404 views.publish → 404 conversations.history → 404 conversations.open → 404 conversations.replies → 404 users.info", async () => {
    // Given: production env.
    mockEnv("ENV", "production");

    // When + Then: 404 for each of the 10 supported methods.
    for (const method of [
      "auth.test",
      "assistant.threads.setStatus",
      "chat.postMessage",
      "chat.postEphemeral",
      "oauth.v2.access",
      "views.publish",
      "conversations.history",
      "conversations.open",
      "conversations.replies",
      "users.info",
    ]) {
      const response = await requestApp(`${BASE_ROUTE}/${method}`, {
        method: "POST",
      });
      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("Not found");
    }
  });
});

describe("BDD POST /api/test/slack-mock/* — 200 dev-env fixture chain", () => {
  it("gwt-wt-wt: 200 returns fixed Slack auth.test and oauth.v2.access fixture payloads → 200 returns fixed Slack conversation and ack payloads → 200 reads users.info user ids from JSON and form-encoded bodies with fixture fallback", async () => {
    // Given: development env.

    // When + Then: 200 — auth.test and oauth.v2.access
    // return the fixed fixture payloads.
    mockEnv("ENV", "development");
    const authResponse = await requestApp(`${BASE_ROUTE}/auth.test`, {
      method: "POST",
    });
    const oauthResponse = await requestApp(`${BASE_ROUTE}/oauth.v2.access`, {
      method: "POST",
    });
    await expect(authResponse.json()).resolves.toStrictEqual({
      ok: true,
      url: "https://e2e-mock.invalid/",
      team: SLACK_E2E_FIXTURES.teamName,
      user: "e2e-bot",
      team_id: SLACK_E2E_FIXTURES.teamId,
      user_id: SLACK_E2E_FIXTURES.botUserId,
      bot_id: SLACK_E2E_FIXTURES.botId,
    });
    await expect(oauthResponse.json()).resolves.toStrictEqual({
      ok: true,
      access_token: SLACK_E2E_FIXTURES.botToken,
      token_type: "bot",
      scope: SLACK_E2E_SCOPES.join(","),
      bot_user_id: SLACK_E2E_FIXTURES.botUserId,
      app_id: SLACK_E2E_FIXTURES.appId,
      team: {
        id: SLACK_E2E_FIXTURES.teamId,
        name: SLACK_E2E_FIXTURES.teamName,
      },
      enterprise: null,
      authed_user: {
        id: SLACK_E2E_FIXTURES.userUserId,
        scope: "",
        access_token: "",
        token_type: "user",
      },
    });

    // When + Then: 200 — conversation and ack methods
    // return the fixed payloads.
    await expect(
      requestApp(`${BASE_ROUTE}/assistant.threads.setStatus`, {
        method: "POST",
      }).then((response) => {
        return response.json();
      }),
    ).resolves.toStrictEqual({ ok: true });
    await expect(
      requestApp(`${BASE_ROUTE}/views.publish`, { method: "POST" }).then(
        (response) => {
          return response.json();
        },
      ),
    ).resolves.toStrictEqual({ ok: true });
    await expect(
      requestApp(`${BASE_ROUTE}/conversations.open`, { method: "POST" }).then(
        (response) => {
          return response.json();
        },
      ),
    ).resolves.toStrictEqual({
      ok: true,
      channel: { id: "D_E2E_MOCK" },
    });
    await expect(
      requestApp(`${BASE_ROUTE}/conversations.history`, {
        method: "POST",
      }).then((response) => {
        return response.json();
      }),
    ).resolves.toStrictEqual({ ok: true, messages: [], has_more: false });
    await expect(
      requestApp(`${BASE_ROUTE}/conversations.replies`, {
        method: "POST",
      }).then((response) => {
        return response.json();
      }),
    ).resolves.toStrictEqual({ ok: true, messages: [], has_more: false });

    // When + Then: 200 — users.info reads user ids from
    // JSON and form-encoded bodies with fixture fallback.
    const jsonResponse = await requestApp(`${BASE_ROUTE}/users.info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "U_JSON_USER" }),
    });
    const formResponse = await requestApp(`${BASE_ROUTE}/users.info`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user: "U_FORM_USER" }),
    });
    const emptyJsonResponse = await requestApp(`${BASE_ROUTE}/users.info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "" }),
    });
    const emptyFormResponse = await requestApp(`${BASE_ROUTE}/users.info`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user: "" }),
    });

    const jsonBody =
      await readJson<TestSlackMockUsersInfoResponse>(jsonResponse);
    const formBody =
      await readJson<TestSlackMockUsersInfoResponse>(formResponse);
    const emptyJsonBody =
      await readJson<TestSlackMockUsersInfoResponse>(emptyJsonResponse);
    const emptyFormBody =
      await readJson<TestSlackMockUsersInfoResponse>(emptyFormResponse);

    expect(jsonBody.user.id).toBe("U_JSON_USER");
    expect(formBody.user.id).toBe("U_FORM_USER");
    expect(emptyJsonBody.user.id).toBe(SLACK_E2E_FIXTURES.userUserId);
    expect(emptyFormBody.user.id).toBe(SLACK_E2E_FIXTURES.userUserId);
  });
});

describe("BDD POST /api/test/slack-mock/* — 200 logged-call chain", () => {
  it("gwt-wt-wt: 200 logs chat.postMessage and chat.postEphemeral calls + DB log rows written", async () => {
    // Given: development env + a clean mock call log.
    mockEnv("ENV", "development");
    await cleanupMockCallLog();

    // When: post to chat.postMessage (form-encoded) and
    // chat.postEphemeral (JSON).
    const messageResponse = await requestApp(`${BASE_ROUTE}/chat.postMessage`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        team_id: LOG_TEST_TEAM_ID,
        channel: "C_TEST_FORM",
        text: "hello from form",
      }),
    });
    const ephemeralResponse = await requestApp(
      `${BASE_ROUTE}/chat.postEphemeral`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          team_id: LOG_TEST_TEAM_ID,
          channel_id: "C_TEST_JSON",
          text: "hello from json",
        }),
      },
    );

    // Then: 200 + the responses match the expected shape.
    expect(messageResponse.status).toBe(200);
    await expect(messageResponse.json()).resolves.toMatchObject({
      ok: true,
      channel: SLACK_E2E_FIXTURES.channelId,
      message: { text: "mocked" },
    });
    expect(ephemeralResponse.status).toBe(200);
    await expect(ephemeralResponse.json()).resolves.toMatchObject({
      ok: true,
      message_ts: expect.stringMatching(/^\d+\.000200$/),
    });

    // Then: the DB log contains both calls.
    const calls = await writeDb
      .select({
        method: e2eSlackMockCallLog.method,
        teamId: e2eSlackMockCallLog.teamId,
        channelId: e2eSlackMockCallLog.channelId,
        bodyJson: e2eSlackMockCallLog.bodyJson,
      })
      .from(e2eSlackMockCallLog)
      .where(
        and(
          eq(e2eSlackMockCallLog.teamId, LOG_TEST_TEAM_ID),
          inArray(e2eSlackMockCallLog.method, [
            "chat.postMessage",
            "chat.postEphemeral",
          ]),
        ),
      );

    expect(calls).toStrictEqual(
      expect.arrayContaining([
        {
          method: "chat.postMessage",
          teamId: LOG_TEST_TEAM_ID,
          channelId: "C_TEST_FORM",
          bodyJson: {
            team_id: LOG_TEST_TEAM_ID,
            channel: "C_TEST_FORM",
            text: "hello from form",
          },
        },
        {
          method: "chat.postEphemeral",
          teamId: LOG_TEST_TEAM_ID,
          channelId: "C_TEST_JSON",
          bodyJson: {
            team_id: LOG_TEST_TEAM_ID,
            channel_id: "C_TEST_JSON",
            text: "hello from json",
          },
        },
      ]),
    );
  });
});
