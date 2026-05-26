import { createHmac, randomBytes } from "node:crypto";

import {
  getModelProviderFirewall,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { createStore } from "ccstate";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq } from "drizzle-orm";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import { decryptSecretsMap } from "../../services/crypto.utils";
import { clearAllDetached } from "../../utils";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  clearSlackWebhookAgentHeadVersion$,
  countSlackWebhookConnections$,
  countSlackWebhookInstallations$,
  deleteSlackWebhookFixture$,
  seedSlackWebhookOrphanCompose$,
  seedSlackWebhookFixture$,
  seedSlackThreadSession$,
  setSlackWebhookDefaultAgent$,
  setSlackWebhookUserAgentPreference$,
  setSlackWebhookUserSelectedModel$,
  type SlackWebhookFixture,
} from "./helpers/zero-slack-webhooks";

const context = testContext();
const store = createStore();
const SIGNING_SECRET = randomBytes(32).toString("hex");
const EVENTS_PATH = "/api/zero/slack/events";
const TEST_VM0_ANTHROPIC_KEY = "vm0-key-claude-sonnet-4-6";
const TEST_VM0_DEEPSEEK_KEY = "vm0-key-deepseek-v4-pro";
const TEST_VM0_OPENAI_KEY = "vm0-key-gpt-5.5";

function modelProviderSecretPlaceholder(
  type: ModelProviderType,
  secretName: string,
): string {
  const placeholder =
    getModelProviderFirewall(type)?.placeholders?.[secretName];
  if (!placeholder) {
    throw new Error(`Missing model provider placeholder for ${secretName}`);
  }
  return placeholder;
}

afterEach(async () => {
  const db = store.set(writeDb$);
  await db
    .delete(vm0ApiKeys)
    .where(eq(vm0ApiKeys.apiKey, TEST_VM0_ANTHROPIC_KEY));
  await db
    .delete(vm0ApiKeys)
    .where(eq(vm0ApiKeys.apiKey, TEST_VM0_DEEPSEEK_KEY));
  await db.delete(vm0ApiKeys).where(eq(vm0ApiKeys.apiKey, TEST_VM0_OPENAI_KEY));
});

async function seedVm0ManagedKeys(): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .delete(vm0ApiKeys)
    .where(eq(vm0ApiKeys.apiKey, TEST_VM0_ANTHROPIC_KEY));
  await db
    .delete(vm0ApiKeys)
    .where(eq(vm0ApiKeys.apiKey, TEST_VM0_DEEPSEEK_KEY));
  await db.insert(vm0ApiKeys).values([
    {
      vendor: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: TEST_VM0_ANTHROPIC_KEY,
    },
    {
      vendor: "deepseek",
      model: "deepseek-v4-pro",
      apiKey: TEST_VM0_DEEPSEEK_KEY,
    },
  ]);
}

function configureSlackWebhookTest(): void {
  mockOptionalEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockEnv("VM0_WEB_URL", "https://www.vm0.test");
  mockEnv("APP_URL", "https://app.vm0.test");
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

function latestPostMessageCall(): {
  readonly text?: string;
  readonly blocks?: unknown;
  readonly channel?: string;
  readonly user?: string;
} {
  const call = context.mocks.slack.chat.postMessage.mock.calls.at(-1);
  if (!call) {
    throw new Error("Expected Slack chat.postMessage to be called");
  }
  return call[0] as {
    readonly text?: string;
    readonly blocks?: unknown;
    readonly channel?: string;
    readonly user?: string;
  };
}

function latestPostEphemeralCall(): {
  readonly text?: string;
  readonly blocks?: unknown;
  readonly channel?: string;
  readonly user?: string;
} {
  const call = context.mocks.slack.chat.postEphemeral.mock.calls.at(-1);
  if (!call) {
    throw new Error("Expected Slack chat.postEphemeral to be called");
  }
  return call[0] as {
    readonly text?: string;
    readonly blocks?: unknown;
    readonly channel?: string;
    readonly user?: string;
  };
}

describe("POST /api/zero/slack/events", () => {
  const track = createFixtureTracker<SlackWebhookFixture>((fixture) => {
    return store.set(deleteSlackWebhookFixture$, fixture, context.signal);
  });

  beforeEach(() => {
    configureSlackWebhookTest();
  });

  it("returns 503 when Slack signing is not configured", async () => {
    mockOptionalEnv("SLACK_SIGNING_SECRET", undefined);

    const response = await postEvent({ type: "event_callback" });

    expect(response.status).toBe(503);
    expect(response.body).toStrictEqual({
      error: "Slack integration is not configured",
    });
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

  it("rejects invalid JSON payloads", async () => {
    const response = await postRawEvent(
      "{not-json",
      signedHeaders("{not-json"),
    );

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({ error: "Invalid JSON payload" });
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

  it("ignores mention and DM events when the workspace is missing or unbound", async () => {
    const missingMention = await postEvent({
      type: "event_callback",
      team_id: "T-missing-mention",
      event: {
        type: "app_mention",
        user: "U-random",
        text: "hello",
        ts: "1710000000.000000",
        channel: "C-test",
      },
    });
    await clearAllDetached();
    expect(missingMention.status).toBe(200);

    const unboundFixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        {
          withConnection: false,
          withDefaultAgent: true,
          installationOrgId: null,
        },
        context.signal,
      ),
    );
    const unboundDm = await postEvent({
      type: "event_callback",
      team_id: unboundFixture.slackWorkspaceId,
      event: {
        type: "message",
        channel_type: "im",
        user: unboundFixture.slackUserId,
        text: "hello",
        ts: "1710000001.000000",
        channel: "D-test",
      },
    });
    await clearAllDetached();

    expect(unboundDm.status).toBe(200);
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
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

  it("notifies connected users when the workspace agent is not configured or cannot be found", async () => {
    const noDefaultMention = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: false },
        context.signal,
      ),
    );
    const mention = await postEvent({
      type: "event_callback",
      team_id: noDefaultMention.slackWorkspaceId,
      event: {
        type: "app_mention",
        user: noDefaultMention.slackUserId,
        text: "hello agent",
        ts: "1710000002.000000",
        channel: "C-test",
      },
    });
    await clearAllDetached();

    expect(mention.status).toBe(200);
    expect(latestPostEphemeralCall().text).toContain("No agent is configured");

    const missingAgentDm = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: false },
        context.signal,
      ),
    );
    const orphan = await store.set(
      seedSlackWebhookOrphanCompose$,
      {
        orgId: missingAgentDm.orgId,
        userId: missingAgentDm.userId,
        namePrefix: "missing-agent",
      },
      context.signal,
    );
    await store.set(
      setSlackWebhookDefaultAgent$,
      { orgId: missingAgentDm.orgId, composeId: orphan.composeId },
      context.signal,
    );

    const dm = await postEvent({
      type: "event_callback",
      team_id: missingAgentDm.slackWorkspaceId,
      event: {
        type: "message",
        channel_type: "im",
        user: missingAgentDm.slackUserId,
        text: "hello in dm",
        ts: "1710000003.000000",
        channel: "D-test",
      },
    });
    await clearAllDetached();

    expect(dm.status).toBe(200);
    expect(latestPostMessageCall().text).toContain("could not be found");
  });

  it("filters direct message events by channel type, bot marker, and subtype", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: false, withDefaultAgent: true },
        context.signal,
      ),
    );

    await postEvent({
      type: "event_callback",
      team_id: fixture.slackWorkspaceId,
      event: {
        type: "message",
        channel_type: "im",
        user: fixture.slackUserId,
        text: "bot message",
        ts: "1710000004.000000",
        channel: "D-test",
        bot_id: "B-bot",
      },
    });
    await postEvent({
      type: "event_callback",
      team_id: fixture.slackWorkspaceId,
      event: {
        type: "message",
        channel_type: "im",
        user: fixture.slackUserId,
        text: "edited message",
        ts: "1710000005.000000",
        channel: "D-test",
        subtype: "message_changed",
      },
    });
    await postEvent({
      type: "event_callback",
      team_id: fixture.slackWorkspaceId,
      event: {
        type: "message",
        channel_type: "channel",
        user: fixture.slackUserId,
        text: "channel message",
        ts: "1710000006.000000",
        channel: "C-test",
      },
    });
    await clearAllDetached();

    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();

    const fileShare = await postEvent({
      type: "event_callback",
      team_id: fixture.slackWorkspaceId,
      event: {
        type: "message",
        channel_type: "im",
        user: fixture.slackUserId,
        text: "file upload",
        ts: "1710000007.000000",
        channel: "D-test",
        subtype: "file_share",
      },
    });
    await clearAllDetached();

    expect(fileShare.status).toBe(200);
    expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
    expect(latestPostMessageCall().text).toBe(
      "Please connect your account first",
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

  it("handles App Home and Messages tab edge cases", async () => {
    const missingHome = await postEvent({
      type: "event_callback",
      team_id: "T-missing-home",
      event: {
        type: "app_home_opened",
        user: "U-random",
        tab: "home",
        channel: "D-home",
      },
    });
    await clearAllDetached();
    expect(missingHome.status).toBe(200);
    expect(context.mocks.slack.views.publish).not.toHaveBeenCalled();

    const disconnected = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: false, withDefaultAgent: true },
        context.signal,
      ),
    );
    await postEvent({
      type: "event_callback",
      team_id: disconnected.slackWorkspaceId,
      event: {
        type: "app_home_opened",
        user: disconnected.slackUserId,
        tab: "home",
        channel: "D-home",
      },
    });
    await clearAllDetached();
    expect(context.mocks.slack.views.publish).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: disconnected.slackUserId }),
    );

    await postEvent({
      type: "event_callback",
      team_id: disconnected.slackWorkspaceId,
      event: {
        type: "app_home_opened",
        user: disconnected.slackUserId,
        tab: "messages",
        channel: "D-home",
      },
    });
    await clearAllDetached();
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();

    const connected = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );
    await postEvent({
      type: "event_callback",
      team_id: connected.slackWorkspaceId,
      event: {
        type: "app_home_opened",
        user: connected.slackUserId,
        tab: "messages",
        channel: "D-welcome",
      },
    });
    await clearAllDetached();
    expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
    expect(latestPostMessageCall().channel).toBe("D-welcome");

    await postEvent({
      type: "event_callback",
      team_id: connected.slackWorkspaceId,
      event: {
        type: "app_home_opened",
        user: connected.slackUserId,
        tab: "messages",
        channel: "D-welcome",
      },
    });
    await clearAllDetached();
    expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
  });

  it("cleans up workspace installations for uninstall and bot token revocation edge cases", async () => {
    const missingUninstall = await postEvent({
      type: "event_callback",
      team_id: "T-missing-uninstall",
      event: { type: "app_uninstalled" },
    });
    await clearAllDetached();
    expect(missingUninstall.status).toBe(200);

    const noConnections = await track(
      store.set(
        seedSlackWebhookFixture$,
        {
          withConnection: false,
          withDefaultAgent: false,
          installationOrgId: null,
        },
        context.signal,
      ),
    );
    await postEvent({
      type: "event_callback",
      team_id: noConnections.slackWorkspaceId,
      event: { type: "app_uninstalled" },
    });
    await clearAllDetached();
    await expect(
      store.set(
        countSlackWebhookInstallations$,
        noConnections.slackWorkspaceId,
        context.signal,
      ),
    ).resolves.toBe(0);

    const revoked = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );
    await postEvent({
      type: "event_callback",
      team_id: revoked.slackWorkspaceId,
      event: {
        type: "tokens_revoked",
        tokens: { bot: ["xoxb-revoked"] },
      },
    });
    await clearAllDetached();

    await expect(
      store.set(
        countSlackWebhookInstallations$,
        revoked.slackWorkspaceId,
        context.signal,
      ),
    ).resolves.toBe(0);
    await expect(
      store.set(
        countSlackWebhookConnections$,
        revoked.slackWorkspaceId,
        context.signal,
      ),
    ).resolves.toBe(0);
  });

  it("creates a Slack-triggered zero run for connected app mentions", async () => {
    await seedVm0ManagedKeys();
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

  it("routes mentions through user agent overrides and falls back for default or stale overrides", async () => {
    const overrideFixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        {
          withConnection: true,
          withDefaultAgent: true,
          withSwitchAgent: true,
        },
        context.signal,
      ),
    );
    if (!overrideFixture.switchAgentId) {
      throw new Error("Expected Slack fixture to include a switch agent");
    }
    await store.set(
      clearSlackWebhookAgentHeadVersion$,
      overrideFixture.switchAgentId,
      context.signal,
    );
    await store.set(
      setSlackWebhookUserAgentPreference$,
      {
        orgId: overrideFixture.orgId,
        userId: overrideFixture.userId,
        composeId: overrideFixture.switchAgentId,
      },
      context.signal,
    );

    const overrideResponse = await postEvent({
      type: "event_callback",
      team_id: overrideFixture.slackWorkspaceId,
      event: {
        type: "app_mention",
        user: overrideFixture.slackUserId,
        text: "hello override",
        ts: "2600.001",
        channel: "C-override",
      },
    });
    await clearAllDetached();

    expect(overrideResponse.status).toBe(200);
    expect(JSON.stringify(latestPostMessageCall().blocks ?? "")).toContain(
      "Sent via switch-agent-",
    );

    context.mocks.slack.chat.postMessage.mockClear();
    const defaultFixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );
    if (!defaultFixture.defaultAgentId) {
      throw new Error("Expected Slack fixture to include a default agent");
    }
    await store.set(
      clearSlackWebhookAgentHeadVersion$,
      defaultFixture.defaultAgentId,
      context.signal,
    );

    const defaultResponse = await postEvent({
      type: "event_callback",
      team_id: defaultFixture.slackWorkspaceId,
      event: {
        type: "app_mention",
        user: defaultFixture.slackUserId,
        text: "hello default",
        ts: "2600.002",
        channel: "C-default",
      },
    });
    await clearAllDetached();

    expect(defaultResponse.status).toBe(200);
    expect(JSON.stringify(latestPostMessageCall().blocks ?? "")).not.toContain(
      "Sent via",
    );

    context.mocks.slack.chat.postMessage.mockClear();
    const staleFixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );
    if (!staleFixture.defaultAgentId) {
      throw new Error("Expected Slack fixture to include a default agent");
    }
    await store.set(
      clearSlackWebhookAgentHeadVersion$,
      staleFixture.defaultAgentId,
      context.signal,
    );
    const orphan = await store.set(
      seedSlackWebhookOrphanCompose$,
      {
        orgId: staleFixture.orgId,
        userId: staleFixture.userId,
        namePrefix: "stale-override",
      },
      context.signal,
    );
    await store.set(
      setSlackWebhookUserAgentPreference$,
      {
        orgId: staleFixture.orgId,
        userId: staleFixture.userId,
        composeId: orphan.composeId,
      },
      context.signal,
    );

    const staleResponse = await postEvent({
      type: "event_callback",
      team_id: staleFixture.slackWorkspaceId,
      event: {
        type: "app_mention",
        user: staleFixture.slackUserId,
        text: "hello stale override",
        ts: "2600.003",
        channel: "C-stale",
      },
    });
    await clearAllDetached();

    expect(staleResponse.status).toBe(200);
    expect(JSON.stringify(latestPostMessageCall().blocks ?? "")).not.toContain(
      "Sent via",
    );
  });

  it("starts a new Slack session when the selected model changed", async () => {
    await seedVm0ManagedKeys();
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

  it("starts a new Slack session when the selected model provider changed", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );
    expect(fixture.defaultAgentId).toBeTruthy();
    const db = store.set(writeDb$);
    await seedVm0ManagedKeys();
    await db.insert(orgModelPolicies).values({
      orgId: fixture.orgId,
      model: "claude-sonnet-4-6",
      isDefault: true,
      defaultProviderType: "vm0",
      credentialScope: "org",
      createdByUserId: fixture.userId,
      updatedByUserId: fixture.userId,
    });

    const channelId = "D-provider";
    const threadTs = "2450.001";
    const previousSessionId = await store.set(
      seedSlackThreadSession$,
      {
        fixture,
        channelId,
        threadTs,
        modelProvider: "openrouter-api-key",
        selectedModel: "claude-sonnet-4-6",
      },
      context.signal,
    );
    await store.set(
      setSlackWebhookUserSelectedModel$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        selectedModel: "claude-sonnet-4-6",
      },
      context.signal,
    );

    const prompt = "provider changed in Slack thread";
    const response = await postEvent({
      type: "event_callback",
      team_id: fixture.slackWorkspaceId,
      event: {
        type: "message",
        channel_type: "im",
        user: fixture.slackUserId,
        text: prompt,
        ts: "2450.002",
        thread_ts: threadTs,
        channel: channelId,
      },
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    const [run] = await db
      .select({
        id: agentRuns.id,
        sessionId: agentRuns.sessionId,
        continuedFromSessionId: agentRuns.continuedFromSessionId,
        modelProvider: zeroRuns.modelProvider,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(agentRuns)
      .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
      .where(eq(agentRuns.prompt, prompt))
      .limit(1);
    expect(run).toMatchObject({
      continuedFromSessionId: null,
      modelProvider: "vm0",
      selectedModel: "claude-sonnet-4-6",
    });
    expect(run?.sessionId).not.toBe(previousSessionId);
  });

  it("starts a new Slack session when the default model provider changed", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );
    expect(fixture.defaultAgentId).toBeTruthy();
    const db = store.set(writeDb$);
    await seedVm0ManagedKeys();
    await db.insert(orgModelPolicies).values({
      orgId: fixture.orgId,
      model: "claude-sonnet-4-6",
      isDefault: true,
      defaultProviderType: "vm0",
      credentialScope: "org",
      createdByUserId: fixture.userId,
      updatedByUserId: fixture.userId,
    });

    const channelId = "D-default-provider";
    const threadTs = "2451.001";
    const previousSessionId = await store.set(
      seedSlackThreadSession$,
      {
        fixture,
        channelId,
        threadTs,
        modelProvider: "openrouter-api-key",
        selectedModel: "claude-sonnet-4-6",
      },
      context.signal,
    );

    const prompt = "default provider changed in Slack thread";
    const response = await postEvent({
      type: "event_callback",
      team_id: fixture.slackWorkspaceId,
      event: {
        type: "message",
        channel_type: "im",
        user: fixture.slackUserId,
        text: prompt,
        ts: "2451.002",
        thread_ts: threadTs,
        channel: channelId,
      },
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    const [run] = await db
      .select({
        id: agentRuns.id,
        sessionId: agentRuns.sessionId,
        continuedFromSessionId: agentRuns.continuedFromSessionId,
        modelProvider: zeroRuns.modelProvider,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(agentRuns)
      .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
      .where(eq(agentRuns.prompt, prompt))
      .limit(1);
    expect(run).toMatchObject({
      continuedFromSessionId: null,
      modelProvider: "vm0",
      selectedModel: "claude-sonnet-4-6",
    });
    expect(run?.sessionId).not.toBe(previousSessionId);
  });

  it("routes Slack selected GPT models through the model policy provider", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );
    expect(fixture.defaultAgentId).toBeTruthy();
    const db = store.set(writeDb$);
    await db
      .delete(vm0ApiKeys)
      .where(
        and(eq(vm0ApiKeys.vendor, "openai"), eq(vm0ApiKeys.model, "gpt-5.5")),
      );
    await db.insert(vm0ApiKeys).values({
      vendor: "openai",
      model: "gpt-5.5",
      apiKey: TEST_VM0_OPENAI_KEY,
    });
    await db.insert(orgModelPolicies).values({
      orgId: fixture.orgId,
      model: "gpt-5.5",
      isDefault: true,
      defaultProviderType: "vm0",
      credentialScope: "org",
      createdByUserId: fixture.userId,
      updatedByUserId: fixture.userId,
    });
    await store.set(
      setSlackWebhookUserSelectedModel$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        selectedModel: "gpt-5.5",
      },
      context.signal,
    );

    const prompt = "use GPT from Slack";
    const response = await postEvent({
      type: "event_callback",
      team_id: fixture.slackWorkspaceId,
      event: {
        type: "message",
        channel_type: "im",
        user: fixture.slackUserId,
        text: prompt,
        ts: "2500.001",
        channel: "D-gpt",
      },
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    const [run] = await db
      .select({
        id: agentRuns.id,
        modelProvider: zeroRuns.modelProvider,
        modelProviderId: zeroRuns.modelProviderId,
        modelProviderCredentialScope: zeroRuns.modelProviderCredentialScope,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(agentRuns)
      .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
      .where(eq(agentRuns.prompt, prompt))
      .limit(1);
    expect(run).toMatchObject({
      modelProvider: "vm0",
      modelProviderId: null,
      modelProviderCredentialScope: null,
      selectedModel: "gpt-5.5",
    });

    const [job] = await db
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, run?.id ?? ""))
      .limit(1);
    const executionContext = job?.executionContext as {
      readonly cliAgentType: string;
      readonly environment: Record<string, string>;
      readonly encryptedSecrets: string | null;
    };
    expect(executionContext.cliAgentType).toBe("codex");
    expect(executionContext.environment).toMatchObject({
      OPENAI_API_KEY: modelProviderSecretPlaceholder(
        "openai-api-key",
        "OPENAI_API_KEY",
      ),
      OPENAI_MODEL: "gpt-5.5",
    });
    expect(decryptSecretsMap(executionContext.encryptedSecrets)).toMatchObject({
      OPENAI_API_KEY: "vm0-key-gpt-5.5",
    });
  });
});
