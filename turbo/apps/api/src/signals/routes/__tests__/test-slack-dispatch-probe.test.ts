import { createStore } from "ccstate";
import { WebClient } from "@slack/web-api";
import type { TestSlackDispatchProbeResponse } from "@vm0/api-contracts/contracts/test-slack-dispatch-probe";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  deleteSlackWebhookFixture$,
  seedSlackWebhookFixture$,
  type SlackWebhookFixture,
} from "./helpers/zero-slack-webhooks";

const context = testContext();
const store = createStore();
const ROUTE = "/api/test/slack-dispatch-probe";
const TEST_VM0_ANTHROPIC_KEY = "vm0-key-slack-dispatch-probe-claude-sonnet-4-6";
const TEST_VM0_DEEPSEEK_KEY = "vm0-key-slack-dispatch-probe-deepseek-v4-pro";

afterEach(async () => {
  const db = store.set(writeDb$);
  await db
    .delete(vm0ApiKeys)
    .where(eq(vm0ApiKeys.apiKey, TEST_VM0_ANTHROPIC_KEY));
  await db
    .delete(vm0ApiKeys)
    .where(eq(vm0ApiKeys.apiKey, TEST_VM0_DEEPSEEK_KEY));
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

function configureSlackProbeTest(): void {
  mockEnv("ENV", "development");
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
}

function requestApp(path: string, init?: RequestInit): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return Promise.resolve(app.request(path, init));
}

function postProbe(body: unknown): Promise<Response> {
  return requestApp(ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function readSingleRunForUser(userId: string): Promise<{
  readonly id: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
}> {
  const db = store.set(writeDb$);
  const [run] = await db
    .select({
      id: agentRuns.id,
      prompt: agentRuns.prompt,
      appendSystemPrompt: agentRuns.appendSystemPrompt,
    })
    .from(agentRuns)
    .where(eq(agentRuns.userId, userId))
    .limit(1);
  if (!run) {
    throw new Error(`No run found for user ${userId}`);
  }
  return run;
}

async function readZeroRunTriggerSource(
  runId: string,
): Promise<string | null | undefined> {
  const db = store.set(writeDb$);
  const [zeroRun] = await db
    .select({ triggerSource: zeroRuns.triggerSource })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return zeroRun?.triggerSource;
}

describe("POST /api/test/slack-dispatch-probe", () => {
  const track = createFixtureTracker<SlackWebhookFixture>((fixture) => {
    return store.set(deleteSlackWebhookFixture$, fixture, context.signal);
  });

  beforeEach(async () => {
    await seedVm0ManagedKeys();
    configureSlackProbeTest();
  });

  it("hides the test endpoint outside allowed environments", async () => {
    mockEnv("ENV", "production");

    const response = await postProbe({});

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("allows Vercel preview runtimes with the internal bypass header", async () => {
    mockEnv("ENV", "production");
    mockOptionalEnv("VERCEL_ENV", "preview");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    const response = await requestApp(ROUTE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vm0-test-endpoint-bypass": "preview-secret",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "team_id, channel_id, user_id, message_text, message_ts required",
    });
  });

  it("allows preview with the schema-backed bypass secret", async () => {
    mockEnv("ENV", "preview");
    mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    const response = await requestApp(ROUTE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vm0-test-endpoint-bypass": "preview-secret",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "team_id, channel_id, user_id, message_text, message_ts required",
    });
  });

  it("allows protected preview rewrites after Vercel consumes bypass headers", async () => {
    mockEnv("ENV", "preview");
    mockOptionalEnv("USE_MOCK_CLAUDE", "true");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    const response = await postProbe({});

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "team_id, channel_id, user_id, message_text, message_ts required",
    });
  });

  it("routes preview Slack Web API calls to API mock routes", async () => {
    mockOptionalEnv("E2E_SLACK_MOCK_ENABLED", "1");
    mockOptionalEnv("VERCEL_URL", "pr-13948-api.vm6.ai");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );

    const response = await postProbe({
      team_id: fixture.slackWorkspaceId,
      channel_id: "C-test",
      user_id: fixture.slackUserId,
      message_text: "mock Slack API",
      message_ts: "1710000003.000000",
    });

    expect(response.status).toBe(200);
    expect(WebClient).toHaveBeenCalledWith(expect.any(String), {
      slackApiUrl: "https://pr-13948-api.vm6.ai/api/test/slack-mock/",
      headers: {
        "x-vercel-protection-bypass": "preview-secret",
        "x-vm0-test-endpoint-bypass": "preview-secret",
      },
      retryConfig: { retries: 1 },
      timeout: 5000,
    });
  });

  it("returns the legacy missing-field error", async () => {
    const response = await postProbe({
      team_id: "T-test",
      channel_id: "C-test",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "team_id, channel_id, user_id, message_text, message_ts required",
    });
  });

  it("synchronously dispatches connected mention probes", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );

    const response = await postProbe({
      team_id: fixture.slackWorkspaceId,
      channel_id: "C-test",
      user_id: fixture.slackUserId,
      message_text: "summarize this channel",
      message_ts: "1710000000.000000",
      channel_type: "channel",
    });

    expect(response.status).toBe(200);
    await expect(
      readJson<TestSlackDispatchProbeResponse>(response),
    ).resolves.toStrictEqual({ ok: true });

    const run = await readSingleRunForUser(fixture.userId);
    expect(run.prompt).toBe("summarize this channel");
    expect(run.appendSystemPrompt).toContain(
      "You are currently running inside: Slack",
    );
    expect(run.appendSystemPrompt).toContain("Channel type: Channel");
    await expect(readZeroRunTriggerSource(run.id)).resolves.toBe("slack");
  });

  it("synchronously dispatches connected direct-message probes", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );

    const response = await postProbe({
      team_id: fixture.slackWorkspaceId,
      channel_id: "D-test",
      user_id: fixture.slackUserId,
      message_text: "hello in dm",
      message_ts: "1710000001.000000",
      channel_type: "im",
    });

    expect(response.status).toBe(200);
    await expect(
      readJson<TestSlackDispatchProbeResponse>(response),
    ).resolves.toStrictEqual({ ok: true });

    const run = await readSingleRunForUser(fixture.userId);
    expect(run.prompt).toBe("hello in dm");
    expect(run.appendSystemPrompt).toContain("Channel type: Direct message");
    expect(
      context.mocks.slack.assistant.threads.setStatus,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "D-test",
        thread_ts: "1710000001.000000",
      }),
    );
  });

  it("serializes synchronous dispatch errors as diagnostic 200 responses", async () => {
    const fixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );
    const statusError = Object.assign(new Error("status update failed"), {
      code: "slack_status_failed",
    });
    context.mocks.slack.assistant.threads.setStatus.mockRejectedValueOnce(
      statusError,
    );

    const response = await postProbe({
      team_id: fixture.slackWorkspaceId,
      channel_id: "C-test",
      user_id: fixture.slackUserId,
      message_text: "trigger an error",
      message_ts: "1710000002.000000",
    });

    expect(response.status).toBe(200);
    const body = await readJson<TestSlackDispatchProbeResponse>(response);
    expect(body).toMatchObject({
      ok: false,
      error: {
        name: "Error",
        message: "status update failed",
        code: "slack_status_failed",
      },
    });
  });
});
