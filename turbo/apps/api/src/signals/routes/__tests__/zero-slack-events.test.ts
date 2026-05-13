import { createHmac, randomBytes } from "node:crypto";

import { createStore } from "ccstate";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { eq } from "drizzle-orm";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import { clearAllDetached } from "../../utils";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  countSlackWebhookConnections$,
  deleteSlackWebhookFixture$,
  seedSlackWebhookFixture$,
  seedSlackThreadSession$,
  setSlackWebhookUserSelectedModel$,
  type SlackWebhookFixture,
} from "./helpers/zero-slack-webhooks";

const context = testContext();
const store = createStore();
const SIGNING_SECRET = randomBytes(32).toString("hex");
const EVENTS_PATH = "/api/zero/slack/events";

function configureSlackWebhookTest(): void {
  mockOptionalEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockEnv("VM0_WEB_URL", "https://app.vm0.test");
  mockEnv("VM0_API_URL", "https://api.vm0.test");
  context.mocks.s3.send.mockResolvedValue({});
  context.mocks.slack.assistant.threads.setStatus.mockResolvedValue({
    ok: true,
  });
  context.mocks.slack.chat.postMessage.mockResolvedValue({
    ok: true,
    ts: "1710000000.000000",
    channel: "C-test",
  });
  context.mocks.slack.chat.postEphemeral.mockResolvedValue({
    ok: true,
    message_ts: "1710000000.000001",
  });
  context.mocks.slack.conversations.history.mockResolvedValue({
    ok: true,
    messages: [],
  });
  context.mocks.slack.conversations.replies.mockResolvedValue({
    ok: true,
    messages: [],
  });
  context.mocks.slack.users.info.mockResolvedValue({
    ok: true,
    user: {
      profile: {
        display_name: "Slack User",
        email: "slack@example.com",
      },
      tz: "UTC",
    },
  });
  context.mocks.slack.views.publish.mockResolvedValue({ ok: true });
}

function signedHeaders(
  body: string,
  timestamp = Math.floor(now() / 1000).toString(),
): Record<string, string> {
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  };
}

async function postEvent(
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{ readonly status: number; readonly body: unknown }> {
  const body = JSON.stringify(payload);
  const response = await createApp({ signal: context.signal }).request(
    EVENTS_PATH,
    {
      method: "POST",
      headers: { ...signedHeaders(body), ...extraHeaders },
      body,
    },
  );
  const contentType = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    body: contentType.includes("application/json")
      ? await response.json()
      : await response.text(),
  };
}

async function postRawEvent(
  body: string,
  headers: Record<string, string>,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await createApp({ signal: context.signal }).request(
    EVENTS_PATH,
    {
      method: "POST",
      headers,
      body,
    },
  );
  return {
    status: response.status,
    body: await response.json(),
  };
}

describe("POST /api/zero/slack/events", () => {
  const track = createFixtureTracker<SlackWebhookFixture>((fixture) => {
    return store.set(deleteSlackWebhookFixture$, fixture, context.signal);
  });

  beforeEach(() => {
    configureSlackWebhookTest();
  });

  it("returns the Slack url_verification challenge", async () => {
    const response = await postEvent({
      type: "url_verification",
      challenge: "challenge-123",
      token: "test-token",
    });

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({ challenge: "challenge-123" });
  });

  it("rejects missing and invalid Slack signatures", async () => {
    const body = JSON.stringify({ type: "event_callback" });
    const missing = await postRawEvent(body, {
      "content-type": "application/json",
    });
    expect(missing.status).toBe(401);
    expect(missing.body).toStrictEqual({
      error: "Missing Slack signature headers",
    });

    const invalid = await postRawEvent(body, {
      "content-type": "application/json",
      "x-slack-request-timestamp": Math.floor(now() / 1000).toString(),
      "x-slack-signature": "v0=invalid",
    });
    expect(invalid.status).toBe(401);
    expect(invalid.body).toStrictEqual({ error: "Invalid signature" });

    const staleTimestamp = (Math.floor(now() / 1000) - 301).toString();
    const stale = await postRawEvent(body, signedHeaders(body, staleTimestamp));
    expect(stale.status).toBe(401);
    expect(stale.body).toStrictEqual({ error: "Invalid signature" });
  });

  it("suppresses Slack retries before scheduling side effects", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );

    const response = await postEvent(
      {
        type: "event_callback",
        team_id: fixture.slackWorkspaceId,
        event: {
          type: "app_mention",
          user: fixture.slackUserId,
          text: "hello",
          ts: "1710000000.000000",
          channel: "C-test",
        },
      },
      { "x-slack-retry-num": "1" },
    );
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    expect(
      context.mocks.slack.assistant.threads.setStatus,
    ).not.toHaveBeenCalled();
  });

  it("prompts disconnected users to connect for mentions and DMs", async () => {
    const mentionFixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: false, withDefaultAgent: true },
        context.signal,
      ),
    );
    const mention = await postEvent({
      type: "event_callback",
      team_id: mentionFixture.slackWorkspaceId,
      event: {
        type: "app_mention",
        user: mentionFixture.slackUserId,
        text: "hello agent",
        ts: "1710000000.000000",
        channel: "C-test",
      },
    });
    await clearAllDetached();

    expect(mention.status).toBe(200);
    expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C-test",
        user: mentionFixture.slackUserId,
      }),
    );

    const dmFixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: false, withDefaultAgent: true },
        context.signal,
      ),
    );
    const dm = await postEvent({
      type: "event_callback",
      team_id: dmFixture.slackWorkspaceId,
      event: {
        type: "message",
        channel_type: "im",
        user: dmFixture.slackUserId,
        text: "hello in dm",
        ts: "1710000001.000000",
        channel: "D-test",
      },
    });
    await clearAllDetached();

    expect(dm.status).toBe(200);
    expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "D-test",
        text: "Please connect your account first",
      }),
    );
  });

  it("refreshes App Home, sends Messages tab welcome once, and cleans up uninstall events", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );

    await postEvent({
      type: "event_callback",
      team_id: fixture.slackWorkspaceId,
      event: {
        type: "app_home_opened",
        user: fixture.slackUserId,
        tab: "home",
        channel: "D-home",
      },
    });
    await clearAllDetached();
    expect(context.mocks.slack.views.publish).toHaveBeenCalledOnce();

    await postEvent({
      type: "event_callback",
      team_id: fixture.slackWorkspaceId,
      event: {
        type: "app_home_opened",
        user: fixture.slackUserId,
        tab: "messages",
        channel: "D-home",
      },
    });
    await clearAllDetached();
    expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "D-home" }),
    );

    await postEvent({
      type: "event_callback",
      team_id: fixture.slackWorkspaceId,
      event: { type: "app_uninstalled" },
    });
    await clearAllDetached();
    await expect(
      store.set(
        countSlackWebhookConnections$,
        fixture.slackWorkspaceId,
        context.signal,
      ),
    ).resolves.toBe(0);
  });

  it("creates a Slack-triggered zero run for connected app mentions", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );
    expect(fixture.defaultAgentId).toBeTruthy();

    const response = await postEvent({
      type: "event_callback",
      team_id: fixture.slackWorkspaceId,
      event: {
        type: "app_mention",
        user: fixture.slackUserId,
        text: "summarize this thread",
        ts: "1710000000.000000",
        channel: "C-test",
      },
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    const db = store.set(writeDb$);
    const [run] = await db
      .select({
        id: agentRuns.id,
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
      })
      .from(agentRuns)
      .where(eq(agentRuns.userId, fixture.userId))
      .limit(1);
    expect(run?.prompt).toBe("summarize this thread");
    expect(run?.appendSystemPrompt).toContain(
      "You are currently running inside: Slack",
    );
    expect(run?.appendSystemPrompt).toContain("Slack display name: Slack User");

    const [zeroRun] = await db
      .select({ triggerSource: zeroRuns.triggerSource })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, run?.id ?? "00000000-0000-0000-0000-000000000000"))
      .limit(1);
    expect(zeroRun?.triggerSource).toBe("slack");
  });

  it("starts a new Slack session when the selected model changed", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );
    expect(fixture.defaultAgentId).toBeTruthy();

    const channelId = "D-model";
    const threadTs = "2400.001";
    const previousSessionId = await store.set(
      seedSlackThreadSession$,
      {
        fixture,
        channelId,
        threadTs,
        selectedModel: "claude-sonnet-4-6",
      },
      context.signal,
    );
    await store.set(
      setSlackWebhookUserSelectedModel$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        selectedModel: "claude-opus-4-7",
      },
      context.signal,
    );

    const prompt = "model changed in Slack thread";
    const response = await postEvent({
      type: "event_callback",
      team_id: fixture.slackWorkspaceId,
      event: {
        type: "message",
        channel_type: "im",
        user: fixture.slackUserId,
        text: prompt,
        ts: "2400.002",
        thread_ts: threadTs,
        channel: channelId,
      },
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    const db = store.set(writeDb$);
    const [run] = await db
      .select({
        id: agentRuns.id,
        sessionId: agentRuns.sessionId,
        continuedFromSessionId: agentRuns.continuedFromSessionId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.prompt, prompt))
      .limit(1);
    expect(run?.continuedFromSessionId).toBeNull();
    expect(run?.sessionId).not.toBe(previousSessionId);
  });
});
