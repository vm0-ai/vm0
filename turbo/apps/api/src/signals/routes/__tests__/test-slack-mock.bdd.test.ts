import { randomUUID } from "node:crypto";

import {
  SLACK_E2E_FIXTURES,
  SLACK_E2E_SCOPES,
  testSlackMockContract,
  type TestSlackMockUsersInfoResponse,
} from "@vm0/api-contracts/contracts/test-slack-mock";
import {
  testSlackStateContract,
  type TestSlackStateResponse,
} from "@vm0/api-contracts/contracts/test-slack-state";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";

const context = testContext();
const BASE_ROUTE = "/api/test/slack-mock";
const SLACK_MOCK_NOW_ISO = "2026-06-10T12:34:56.000Z";

function slackMockClient() {
  return setupApp({ context })(testSlackMockContract);
}

function slackStateClient() {
  return setupApp({ context })(testSlackStateContract);
}

async function rawRequest(path: string, init?: RequestInit): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request(path, init);
}

async function readRawJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function formHeaders(): HeadersInit {
  return { "content-type": "application/x-www-form-urlencoded" };
}

function formBody(body: Record<string, string>): URLSearchParams {
  return new URLSearchParams(body);
}

function testTeamId(): string {
  return `T_BDD_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function findMockCall(
  state: TestSlackStateResponse,
  method: string,
  teamId: string,
): TestSlackStateResponse["mock_calls"][number] {
  const call = state.mock_calls.find((entry) => {
    return entry.method === method && entry.teamId === teamId;
  });
  if (!call) {
    throw new Error(`Expected ${method} mock call for ${teamId}`);
  }
  return call;
}

describe("/api/test/slack-mock/* BDD", () => {
  it("hides every Slack mock endpoint outside allowed test environments", async () => {
    mockEnv("ENV", "production");
    const client = slackMockClient();

    const assistant = await accept(
      client.assistantThreadsSetStatus({ body: undefined }),
      [404],
    );
    const auth = await accept(client.authTest({ body: undefined }), [404]);
    const postEphemeral = await accept(
      client.chatPostEphemeral({ body: undefined }),
      [404],
    );
    const postMessage = await accept(
      client.chatPostMessage({ body: undefined }),
      [404],
    );
    const history = await accept(
      client.conversationsHistory({ body: undefined }),
      [404],
    );
    const open = await accept(
      client.conversationsOpen({ body: undefined }),
      [404],
    );
    const replies = await accept(
      client.conversationsReplies({ body: undefined }),
      [404],
    );
    const oauth = await accept(
      client.oauthV2Access({ body: undefined }),
      [404],
    );
    const users = await accept(client.usersInfo({ body: undefined }), [404]);
    const views = await accept(client.viewsPublish({ body: undefined }), [404]);

    expect([
      assistant.body,
      auth.body,
      postEphemeral.body,
      postMessage.body,
      history.body,
      open.body,
      replies.body,
      oauth.body,
      users.body,
      views.body,
    ]).toStrictEqual(
      Array.from({ length: 10 }, () => {
        return "Not found";
      }),
    );
  });

  it("serves Slack fixtures, parses bodies, and exposes chat call logs through state API", async () => {
    mockEnv("ENV", "development");
    const slackMockNow = new Date(SLACK_MOCK_NOW_ISO);
    mockNow(slackMockNow);
    const client = slackMockClient();

    const auth = await accept(client.authTest({ body: {} }), [200]);
    const oauth = await accept(client.oauthV2Access({ body: {} }), [200]);

    expect(auth.body).toStrictEqual({
      ok: true,
      url: "https://e2e-mock.invalid/",
      team: SLACK_E2E_FIXTURES.teamName,
      user: "e2e-bot",
      team_id: SLACK_E2E_FIXTURES.teamId,
      user_id: SLACK_E2E_FIXTURES.botUserId,
      bot_id: SLACK_E2E_FIXTURES.botId,
    });
    expect(oauth.body).toStrictEqual({
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

    const assistant = await accept(
      client.assistantThreadsSetStatus({ body: {} }),
      [200],
    );
    const views = await accept(client.viewsPublish({ body: {} }), [200]);
    const open = await accept(client.conversationsOpen({ body: {} }), [200]);
    const history = await accept(
      client.conversationsHistory({ body: {} }),
      [200],
    );
    const replies = await accept(
      client.conversationsReplies({ body: {} }),
      [200],
    );

    expect(assistant.body).toStrictEqual({ ok: true });
    expect(views.body).toStrictEqual({ ok: true });
    expect(open.body).toStrictEqual({
      ok: true,
      channel: { id: "D_E2E_MOCK" },
    });
    expect(history.body).toStrictEqual({
      ok: true,
      messages: [],
      has_more: false,
    });
    expect(replies.body).toStrictEqual({
      ok: true,
      messages: [],
      has_more: false,
    });

    const jsonUser = await accept(
      client.usersInfo({ body: { user: "U_JSON_USER" } }),
      [200],
    );
    const emptyJsonUser = await accept(
      client.usersInfo({ body: { user: "" } }),
      [200],
    );
    const formUserResponse = await rawRequest(`${BASE_ROUTE}/users.info`, {
      method: "POST",
      headers: formHeaders(),
      body: formBody({ user: "U_FORM_USER" }),
    });
    const emptyFormUserResponse = await rawRequest(`${BASE_ROUTE}/users.info`, {
      method: "POST",
      headers: formHeaders(),
      body: formBody({ user: "" }),
    });

    const formUser =
      await readRawJson<TestSlackMockUsersInfoResponse>(formUserResponse);
    const emptyFormUser = await readRawJson<TestSlackMockUsersInfoResponse>(
      emptyFormUserResponse,
    );

    expect(jsonUser.body.user.id).toBe("U_JSON_USER");
    expect(formUser.user.id).toBe("U_FORM_USER");
    expect(emptyJsonUser.body.user.id).toBe(SLACK_E2E_FIXTURES.userUserId);
    expect(emptyFormUser.user.id).toBe(SLACK_E2E_FIXTURES.userUserId);

    const teamId = testTeamId();
    const mockSecond = Math.floor(slackMockNow.getTime() / 1000);
    const postMessageResponse = await rawRequest(
      `${BASE_ROUTE}/chat.postMessage`,
      {
        method: "POST",
        headers: formHeaders(),
        body: formBody({
          team_id: teamId,
          channel: "C_TEST_FORM",
          text: "hello from form",
        }),
      },
    );
    const postEphemeral = await accept(
      client.chatPostEphemeral({
        body: {
          team_id: teamId,
          channel_id: "C_TEST_JSON",
          text: "hello from json",
        },
      }),
      [200],
    );
    const postMessage = await readRawJson<{
      readonly ok: true;
      readonly channel: string;
      readonly ts: string;
      readonly message: { readonly ts: string; readonly text: string };
    }>(postMessageResponse);

    expect(postMessageResponse.status).toBe(200);
    expect(postMessage).toStrictEqual({
      ok: true,
      channel: SLACK_E2E_FIXTURES.channelId,
      ts: `${mockSecond}.000100`,
      message: {
        ts: `${mockSecond}.000100`,
        text: "mocked",
      },
    });
    expect(postEphemeral.body).toStrictEqual({
      ok: true,
      message_ts: `${mockSecond}.000200`,
    });

    const state = await accept(
      slackStateClient().get({ query: { team_id: teamId } }),
      [200],
    );
    const messageCall = findMockCall(state.body, "chat.postMessage", teamId);
    const ephemeralCall = findMockCall(
      state.body,
      "chat.postEphemeral",
      teamId,
    );

    expect(messageCall).toMatchObject({
      method: "chat.postMessage",
      teamId,
      channelId: "C_TEST_FORM",
      bodyJson: {
        team_id: teamId,
        channel: "C_TEST_FORM",
        text: "hello from form",
      },
    });
    expect(ephemeralCall).toMatchObject({
      method: "chat.postEphemeral",
      teamId,
      channelId: "C_TEST_JSON",
      bodyJson: {
        team_id: teamId,
        channel_id: "C_TEST_JSON",
        text: "hello from json",
      },
    });
  });
});
